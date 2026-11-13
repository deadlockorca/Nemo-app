import { spawn } from 'node:child_process';
import path from 'node:path';
import { prepareStorage, storageRoot, type SigningSecrets } from './install-storage';
import { InputError } from './validation';
import type { SigningSetMetadata } from './signing-set-types';
export async function inspectSigningSet(input: SigningSecrets): Promise<SigningSetMetadata> {
  await prepareStorage();
  return new Promise((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ process.env.IOS_SIGN_PYTHON || 'python3', [path.join(process.cwd(), 'scripts/ios/signing_assets.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', invalid = false;
    const timer = setTimeout(() => { invalid = true; child.kill('SIGKILL'); }, 30000);
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 128 * 1024) { invalid = true; child.kill('SIGKILL'); } });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new InputError('Công cụ kiểm tra bộ ký chưa sẵn sàng.', 503)); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(output);
        if (code !== 0 || invalid || r.error || !/^[a-f0-9]{64}$/.test(r.certificateSha256) ||
            !Array.isArray(r.udids) || !r.udids.length || r.udids.length > 1000 ||
            r.udids.some((d: unknown) => typeof d !== 'string' || !/^(?:[A-F0-9]{8}-[A-F0-9]{16}|[A-F0-9]{40})$/.test(d)) ||
            !Number.isFinite(Date.parse(r.certificateExpiresAt)) || !Number.isFinite(Date.parse(r.profileExpiresAt))) throw new Error();
        resolve(r);
      } catch { reject(new InputError('Bộ ký không hợp lệ: kiểm tra mật khẩu, cặp .p12/profile, hạn sử dụng và quyền ký Nemo. Profile phải có danh sách UDID.')); }
    });
    child.stdin.end(JSON.stringify({ ...input, tempRoot: storageRoot() }));
  });
}
