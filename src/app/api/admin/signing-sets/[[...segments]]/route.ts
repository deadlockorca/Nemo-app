import { currentAdmin } from '@/lib/auth';
import { sameOrigin } from '@/lib/http';
import { installJson, installJsonBody, limitedBody } from '@/lib/install-http';
import { InputError } from '@/lib/validation';
import { createSigningSet, listSigningSets, signingSetDetail, changeSigningSet } from '@/lib/signing-sets';
export const runtime = 'nodejs';
type Context = { params: Promise<{ segments?: string[] }> };
async function handle(request: Request, context: Context) {
  try {
    const admin = await currentAdmin();
    if (!admin) return installJson({ error: 'Hãy đăng nhập quản trị.' }, 401);
    if (request.method !== 'GET' && !sameOrigin(request)) return installJson({ error: 'Yêu cầu không hợp lệ.' }, 403);
    const parts = (await context.params).segments || [], params = new URL(request.url).searchParams;
    if (request.method === 'GET' && !parts.length) return installJson(await listSigningSets(params));
    if (request.method === 'GET' && parts.length === 1) return installJson(await signingSetDetail(parts[0], params));
    if (request.method === 'POST' && parts.length === 2) return installJson(await changeSigningSet(admin, parts[0], parts[1], await installJsonBody(request, 16384)));
    if (request.method !== 'POST' || parts.length) return installJson({ error: 'Không tìm thấy chức năng.' }, 404);
    const type = request.headers.get('content-type') || '';
    if (!type.startsWith('multipart/form-data;')) throw new InputError('Cần tải lên bộ ký.', 415);
    const bytes = await limitedBody(request, 3 * 1024 * 1024 + 32768);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { 'Content-Type': type } }).formData(); }
    catch { throw new InputError('Không đọc được dữ liệu tải lên.'); }
    return installJson(await createSigningSet(admin, form), 201);
  } catch (e) {
    if (e instanceof InputError) return installJson({ error: e.message }, e.status);
    console.error('Signing set operation failed.');
    return installJson({ error: 'Chưa xử lý được bộ ký. Hãy tải lại rồi thử lại.' }, 503);
  }
}
export const GET = handle;
export const POST = handle;
