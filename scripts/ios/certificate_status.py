"""Verify public Apple OCSP/CRL evidence. No private key is used or transmitted.

JSON stdin: Apple-signed profile (base64), expected signing certificate SHA256.
JSON stdout: bounded status/evidence metadata; errors never print assets/URLs.
"""
import base64
import datetime as dt
import json
from pathlib import Path
import re
import sys
import tempfile
import urllib.request
from urllib.parse import urlsplit

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, ec, ed25519, ed448, padding
from cryptography.x509 import ocsp
from package import verify_profile, HERE
from verify import check_critical_extensions

UTC = dt.timezone.utc
SKEW = dt.timedelta(minutes=5)
HOSTS = {'ocsp.apple.com', 'ocsp2.apple.com', 'crl.apple.com', 'developer.apple.com'}


class Unverified(ValueError):
    pass


def require(value):
    if not value:
        raise Unverified('unverified_response')


def endpoint(url):
    parts = urlsplit(url)
    require(parts.scheme in ('http', 'https') and parts.hostname in HOSTS and
            parts.port in (None, 80 if parts.scheme == 'http' else 443) and
            not parts.username and not parts.password and not parts.fragment and
            len(url) <= 2048 and not re.search(r'[\x00-\x20\x7f]', url))
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Unverified('redirect_not_allowed')


def fetch(url, data=None):
    # Public, fixed Apple hosts only; neither proxies nor redirects can send
    # status requests to customer-controlled hosts or internal services.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    headers = {'User-Agent': 'Nemo-Certificate-Monitor/1', 'Accept': 'application/ocsp-response' if data else 'application/pkix-crl'}
    if data:
        headers['Content-Type'] = 'application/ocsp-request'
    with opener.open(urllib.request.Request(endpoint(url), data=data, headers=headers), timeout=15) as response:
        require(response.status == 200)
        body = response.read(10 * 1024 * 1024 + 1)
        require(len(body) <= 10 * 1024 * 1024)
        return body


def verify_signature(key, signature, data, algorithm):
    if isinstance(key, rsa.RSAPublicKey):
        # PSS responses are conservatively unknown until parameters are supported.
        key.verify(signature, data, padding.PKCS1v15(), algorithm)
    elif isinstance(key, ec.EllipticCurvePublicKey):
        key.verify(signature, data, ec.ECDSA(algorithm))
    elif isinstance(key, (ed25519.Ed25519PublicKey, ed448.Ed448PublicKey)):
        key.verify(signature, data)
    else:
        raise Unverified('unsupported_signature')


def freshness(this_update, next_update, now):
    require(this_update <= now + SKEW)
    valid_until = next_update or this_update + dt.timedelta(hours=1)
    require(this_update < valid_until and now < valid_until and
            valid_until - this_update <= dt.timedelta(days=14))
    return valid_until


def verify_ocsp(raw, cert, issuer, now):
    response = ocsp.load_der_ocsp_response(raw)
    require(response.response_status == ocsp.OCSPResponseStatus.SUCCESSFUL)
    singles = list(response.responses)
    require(len(singles) == 1)
    single = singles[0]
    requested = ocsp.OCSPRequestBuilder().add_certificate(cert, issuer, single.hash_algorithm).build()
    require(single.serial_number == requested.serial_number and
            single.issuer_name_hash == requested.issuer_name_hash and single.issuer_key_hash == requested.issuer_key_hash)
    require(not any(ext.critical for ext in response.extensions))
    signer = None
    for candidate in [issuer, *response.certificates]:
        matches = ((response.responder_name is not None and candidate.subject == response.responder_name) or
                   (response.responder_key_hash is not None and
                    x509.SubjectKeyIdentifier.from_public_key(candidate.public_key()).digest == response.responder_key_hash))
        if not matches:
            continue
        try:
            if candidate.fingerprint(hashes.SHA256()) != issuer.fingerprint(hashes.SHA256()):
                candidate.verify_directly_issued_by(issuer)
                require(candidate.not_valid_before_utc <= now < candidate.not_valid_after_utc)
                require(x509.ExtendedKeyUsageOID.OCSP_SIGNING in candidate.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value)
                require(all(not e.critical or e.oid in (x509.ExtensionOID.BASIC_CONSTRAINTS, x509.ExtensionOID.KEY_USAGE, x509.ExtensionOID.EXTENDED_KEY_USAGE) for e in candidate.extensions))
                try:
                    require(candidate.extensions.get_extension_for_class(x509.KeyUsage).value.digital_signature)
                except x509.ExtensionNotFound:
                    pass
            verify_signature(candidate.public_key(), response.signature, response.tbs_response_bytes, response.signature_hash_algorithm)
            signer = candidate
            break
        except Exception:
            continue
    require(signer is not None)
    valid_until = freshness(single.this_update_utc, single.next_update_utc, now)
    require(single.this_update_utc - SKEW <= response.produced_at_utc <= now + SKEW)
    if single.certificate_status == ocsp.OCSPCertStatus.UNKNOWN:
        raise Unverified('responder_unknown')
    if single.certificate_status == ocsp.OCSPCertStatus.REVOKED:
        require(single.revocation_time_utc is not None and single.revocation_time_utc <= now + SKEW)
        return {'status': 'revoked', 'method': 'ocsp', 'validUntil': valid_until.isoformat()}
    return {'status': 'good', 'method': 'ocsp', 'validUntil': valid_until.isoformat()}


def verify_crl(raw, cert, issuer, now):
    crl = x509.load_der_x509_crl(raw)
    require(crl.issuer == issuer.subject and crl.is_signature_valid(issuer.public_key()))
    # Partial/indirect/delta CRLs cannot establish that an absent serial is good.
    require(not any(e.critical or e.oid in (x509.ExtensionOID.DELTA_CRL_INDICATOR, x509.ExtensionOID.ISSUING_DISTRIBUTION_POINT) for e in crl.extensions))
    require(crl.next_update_utc is not None)
    valid_until = freshness(crl.last_update_utc, crl.next_update_utc, now)
    entry = crl.get_revoked_certificate_by_serial_number(cert.serial_number)
    if entry:
        require(entry.revocation_date_utc <= now + SKEW)
        require(not any(e.critical for e in entry.extensions))
        try:
            require(entry.extensions.get_extension_for_class(x509.CRLReason).value.reason != x509.ReasonFlags.remove_from_crl)
        except x509.ExtensionNotFound:
            pass
    return {'status': 'revoked' if entry else 'good', 'method': 'crl', 'validUntil': valid_until.isoformat()}


def check_certificate(cert, issuer, now, fetcher=fetch):
    cert.verify_directly_issued_by(issuer)
    check_critical_extensions([cert, issuer])
    require(issuer.not_valid_before_utc <= now < issuer.not_valid_after_utc)
    require(x509.ExtendedKeyUsageOID.CODE_SIGNING in cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value)
    if cert.not_valid_after_utc <= now:
        return {'status': 'expired', 'method': None, 'validUntil': None, 'detail': 'certificate_expired'}
    require(cert.not_valid_before_utc <= now)
    failures = []
    try:
        urls = [a.access_location.value for a in cert.extensions.get_extension_for_class(x509.AuthorityInformationAccess).value
                if a.access_method == x509.AuthorityInformationAccessOID.OCSP and isinstance(a.access_location, x509.UniformResourceIdentifier)]
    except x509.ExtensionNotFound:
        urls = []
    request = ocsp.OCSPRequestBuilder().add_certificate(cert, issuer, hashes.SHA1()).build().public_bytes(serialization.Encoding.DER)
    for url in urls[:2]:
        try:
            result = verify_ocsp(fetcher(endpoint(url), request), cert, issuer, now)
            return {**result, 'detail': 'verified'}
        except Exception:
            failures.append('ocsp_unverified')
    try:
        urls = [n.value for dp in cert.extensions.get_extension_for_class(x509.CRLDistributionPoints).value
                if dp.crl_issuer is None and dp.reasons is None for n in (dp.full_name or []) if isinstance(n, x509.UniformResourceIdentifier)]
    except x509.ExtensionNotFound:
        urls = []
    for url in urls[:2]:
        try:
            result = verify_crl(fetcher(endpoint(url)), cert, issuer, now)
            return {**result, 'detail': 'verified'}
        except Exception:
            failures.append('crl_unverified')
    return {'status': 'unknown', 'detail': failures[-1] if failures else 'no_status_endpoint', 'method': None, 'validUntil': None}


def profile_assets(data, stage):
    profile = verify_profile(base64.b64decode(data['profile'], validate=True), stage)
    raw_certs = profile.get('DeveloperCertificates', [])
    require(1 <= len(raw_certs) <= 16)
    certs = [x509.load_der_x509_certificate(c) for c in raw_certs]
    issuers = x509.load_pem_x509_certificates((HERE / 'apple-chain.pem').read_bytes())
    for cert in certs:
        issuer = next(c for c in issuers if c.subject == cert.issuer)
        cert.verify_directly_issued_by(issuer)
        check_critical_extensions([cert, issuer])
        require(x509.ExtendedKeyUsageOID.CODE_SIGNING in cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value)
    return profile, certs, issuers


def inspect(data, stage):
    profile, certs, issuers = profile_assets(data, stage)
    if data.get('mode') == 'inspect-profile':
        require(data['udid'].upper() in [d.upper() for d in profile.get('ProvisionedDevices', [])])
        choices = [{'sha256': c.fingerprint(hashes.SHA256()).hex(), 'expiresAt': c.not_valid_after_utc.isoformat()} for c in certs]
        return {'certificates': choices, 'profileExpiresAt': profile['ExpirationDate'].replace(tzinfo=UTC).isoformat(),
                'profileName': str(profile.get('Name', ''))[:200]}
    digest = data.get('certificateSha256', '')
    require(isinstance(digest, str) and re.fullmatch('[a-f0-9]{64}', digest))
    cert = next(c for c in certs if c.fingerprint(hashes.SHA256()).hex() == digest)
    issuer = next(c for c in issuers if c.subject == cert.issuer)
    return check_certificate(cert, issuer, dt.datetime.now(UTC))


def main():
    try:
        raw = sys.stdin.buffer.read(3 * 1024 * 1024 + 1)
        require(len(raw) <= 3 * 1024 * 1024)
        with tempfile.TemporaryDirectory(prefix='nemo-cert-status-') as directory:
            result = inspect(json.loads(raw), Path(directory))
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'status': 'unknown', 'detail': 'invalid_assets_or_response', 'method': None, 'validUntil': None}))


if __name__ == '__main__':
    main()
