#import "NLCrypto.h"
int main(int argc, char **argv) { @autoreleasepool {
    if (argc != 2) return 2;
    NSDictionary *fixture = [NSJSONSerialization JSONObjectWithData:
        [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[1]]] options:0 error:nil];
    NSData *publicKey = [[NSData alloc] initWithBase64EncodedString:fixture[@"publicKey"] options:0];
    double now = [fixture[@"now"] doubleValue];
    NSDictionary *claims = NLVerifyLease(fixture[@"token"], publicKey, fixture[@"kid"], fixture[@"device"], now);
    if (!claims || ![claims[@"identity"] isEqual:fixture[@"identity"]]) return 3;
    if (NLVerifyLease(fixture[@"token"], publicKey, fixture[@"kid"], @"wrong-device", now)) return 4;
    if (NLVerifyLease(fixture[@"token"], publicKey, fixture[@"kid"], fixture[@"device"], [claims[@"exp"] doubleValue])) return 5;
    NSArray *parts = [fixture[@"token"] componentsSeparatedByString:@"."];
    NSString *tampered = [NSString stringWithFormat:@"%@.eyJ2IjoxfQ.%@", parts[0], parts[2]];
    if (NLVerifyLease(tampered, publicKey, fixture[@"kid"], fixture[@"device"], now)) return 6;
    puts("PASS: actual API JWT and exact identity verified by the blank IPA's Objective-C verifier; tamper/device/expiry rejected.");
    return 0;
} }
