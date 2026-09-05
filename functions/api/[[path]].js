// Cloudflare Pages Function：捕获所有 /api/* 请求。
// 真正的处理逻辑在 core/handler.mjs（与 functions/ 同级，不会被当作路由）。
export { onRequest } from '../../core/handler.mjs';
