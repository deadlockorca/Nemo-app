"""Compile against the existing blank IPA sources; fixture uses an isolated test key."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(sys.argv[1]).resolve()
fixture = Path(os.environ['NATIVE_CONTRACT_FIXTURE'])
here = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='nemo-api-contract-') as tmp:
    obj = Path(tmp) / 'tweetnacl.o'
    output = Path(tmp) / 'contract-test'
    subprocess.run(['clang', '-O1', '-Wno-sign-compare', '-Wno-unterminated-string-initialization',
                    '-c', str(root / 'vendor/tweetnacl.c'), '-o', str(obj)], check=True)
    subprocess.run(['clang', '-fobjc-arc', '-fmodules', '-O1', '-I', str(root), '-framework', 'Foundation',
                    '-framework', 'Security', str(here / 'ios/verify-contract.m'), str(root / 'NLCrypto.m'),
                    str(obj), '-o', str(output)], check=True)
    subprocess.run([str(output), str(fixture)], check=True)
