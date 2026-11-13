import { currentAdmin } from '@/lib/auth';
import { appOrigin, sameOrigin } from '@/lib/http';
import { installJson, installJsonBody } from '@/lib/install-http';
import { InputError } from '@/lib/validation';
import { replacementContext, queueReplacement, cancelReplacement, issueReplacement } from '@/lib/signing-replacements';
export const runtime = 'nodejs';
type Context = { params: Promise<{ segments?: string[] }> };
async function handle(request: Request, context: Context) {
  try {
    const admin = await currentAdmin();
    if (!admin) return installJson({ error: 'Hãy đăng nhập quản trị.' }, 401);
    if (request.method !== 'GET' && !sameOrigin(request)) return installJson({ error: 'Yêu cầu không hợp lệ.' }, 403);
    const parts = (await context.params).segments || [];
    if (request.method === 'GET' && parts.length === 1) return installJson(await replacementContext(parts[0]));
    if (request.method === 'POST' && parts.length === 2) {
      const body = await installJsonBody(request);
      if (parts[1] === 'queue') return installJson(await queueReplacement(admin, parts[0], body), 201);
      if (parts[1] === 'cancel') return installJson(await cancelReplacement(admin, parts[0]));
      if (parts[1] === 'issue') {
        const result = await issueReplacement(admin, parts[0]);
        return installJson({ ...result, url: `${appOrigin()}/install#code=${result.code}` });
      }
    }
    return installJson({ error: 'Không tìm thấy chức năng.' }, 404);
  } catch (e) {
    if (e instanceof InputError) return installJson({ error: e.message }, e.status);
    console.error('Signing replacement operation failed.');
    return installJson({ error: 'Chưa xử lý được yêu cầu. Hãy tải lại lịch sử trước khi thử lại.' }, 503);
  }
}
export const GET = handle;
export const POST = handle;
