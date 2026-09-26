"use strict";

const http = require("node:http");
const { createDomain, DomainError } = require("./domain");
const { openDatabase } = require("./db");

const JSON_LIMIT_BYTES = 1_048_576;

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > JSON_LIMIT_BYTES) {
        reject(new DomainError("VALIDATION_ERROR", "请求体超过 1MiB 限制", { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new DomainError("VALIDATION_ERROR", "请求体不是合法 JSON", { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function bearerToken(request) {
  const header = request.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

// 路由表：[method, pattern(matcher 返回路径参数或 null), 处理器名]
function createServer(options = {}) {
  const db = options.db || openDatabase();
  const domain = createDomain(db);

  const routes = buildRoutes(domain);

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      for (const route of routes) {
        if (route.method !== request.method) continue;
        const params = route.match(url.pathname);
        if (!params) continue;
        let body = {};
        if (!["GET", "HEAD"].includes(request.method)) {
          body = await readBody(request);
        }
        const result = await route.handler({ params, body, query: url.searchParams, request });
        sendJson(response, result.status, result.body);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof DomainError) {
        sendJson(response, error.status, { error: error.code, message: error.message, details: error.details });
        return;
      }
      sendJson(response, 500, { error: "internal_error", message: error.message });
    }
  });

  server.on("close", () => {
    if (!options.keepDbOpen) db.close();
  });

  return server;
}

// 简单模式匹配：/segments/:param
function compilePattern(pattern) {
  const parts = pattern.split("/").filter(Boolean);
  return (pathname) => {
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length !== parts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].startsWith(":")) {
        params[parts[i].slice(1)] = decodeURIComponent(segments[i]);
      } else if (parts[i] !== segments[i]) {
        return null;
      }
    }
    return params;
  };
}

function ok(body, status = 200) {
  return { status, body };
}

function buildRoutes(domain) {
  const defs = [
    // ---------- 健康检查 ----------
    ["GET", "/health", () => ok({ status: "ok" })],
    // ---------- 基础资料 ----------
    ["GET", "/categories", () => ok({ categories: domain.listCategories() })],
    ["PUT", "/categories/:code", ({ params, body }) =>
      ok(domain.upsertCategory({
        category_code: params.code,
        name: body.name,
        hs_codes: body.hs_codes,
      }))],
    ["PUT", "/authorities/:ref", ({ params, body }) =>
      ok(domain.upsertAuthority({
        authority_ref: params.ref,
        name: body.name,
        country_code: body.country_code,
      }))],
    ["PUT", "/suppliers/:ref", ({ params, body }) =>
      ok(domain.registerSupplier({
        supplier_ref: params.ref,
        display_name: body.display_name,
        country_code: body.country_code,
        access_token: body.access_token,
      }))],
    ["PUT", "/facilities/:ref", ({ params, body }) =>
      ok(domain.upsertFacility({
        facility_ref: params.ref,
        supplier_ref: body.supplier_ref,
        name: body.name,
        country_code: body.country_code,
      }))],

    // ---------- 设施注册 ----------
    ["POST", "/facilities/:ref/registrations", ({ params, body }) =>
      ok(domain.submitRegistration({ facility_ref: params.ref, authority_ref: body.authority_ref }), 201)],
    ["POST", "/registrations/mark-registered", ({ body }) =>
      ok(domain.markRegistered({ facility_ref: body.facility_ref, authority_ref: body.authority_ref }))],
    ["POST", "/registrations/suspend", ({ body }) =>
      ok(domain.setRegistrationStatus(body.facility_ref, body.authority_ref, "suspended"))],
    ["GET", "/registrations", ({ query }) => {
      const supplier_ref = query.get("supplier_ref");
      if (!supplier_ref) throw new DomainError("VALIDATION_ERROR", "缺少 supplier_ref 查询参数", { status: 400 });
      return ok({ registrations: domain.listRegistrations(supplier_ref) });
    }],

    // ---------- 材料与补件 ----------
    ["POST", "/materials", ({ body }) => {
      const result = domain.submitMaterial(body);
      return ok(result, result.merged ? 200 : 201);
    }],
    ["GET", "/materials", ({ query }) => {
      const supplier_ref = query.get("supplier_ref");
      if (!supplier_ref) throw new DomainError("VALIDATION_ERROR", "缺少 supplier_ref 查询参数", { status: 400 });
      return ok({
        materials: domain.listMaterials(supplier_ref, {
          facility_ref: query.get("facility_ref") || undefined,
          product_category: query.get("product_category") || undefined,
          doc_type: query.get("doc_type") || undefined,
        }),
      });
    }],
    ["POST", "/materials/:id/supplement-requests", ({ params, body }) =>
      ok(domain.requestSupplement({ material_id: params.id, detail: body.detail }), 201)],
    ["POST", "/supplement-requests/:id/resolve", ({ params }) =>
      ok(domain.resolveSupplement(params.id))],

    // ---------- 批准 ----------
    ["POST", "/approvals", ({ body }) =>
      ok(domain.grantApproval(body), 201)],
    ["GET", "/approvals", ({ query }) => {
      const supplier_ref = query.get("supplier_ref");
      if (!supplier_ref) throw new DomainError("VALIDATION_ERROR", "缺少 supplier_ref 查询参数", { status: 400 });
      return ok({ approvals: domain.listApprovals(supplier_ref) });
    }],

    // ---------- 采购意向 ----------
    ["POST", "/intentions", ({ body }) => ok(domain.createIntention(body), 201)],
    ["GET", "/intentions", ({ query }) => {
      const supplier_ref = query.get("supplier_ref");
      if (!supplier_ref) throw new DomainError("VALIDATION_ERROR", "缺少 supplier_ref 查询参数", { status: 400 });
      return ok({ intentions: domain.listIntentions(supplier_ref, { status: query.get("status") || undefined }) });
    }],
    ["POST", "/intentions/:id/confirm", ({ params }) => ok(domain.confirmIntention(params.id))],
    ["POST", "/intentions/:id/withdraw", ({ params }) => ok(domain.withdrawIntention(params.id))],
    ["POST", "/intentions/:id/convert", ({ params }) => {
      const result = domain.convertIntention(params.id);
      return ok(result, 201);
    }],

    // ---------- 订单与通关批次 ----------
    ["GET", "/orders", ({ query }) => {
      const supplier_ref = query.get("supplier_ref");
      if (!supplier_ref) throw new DomainError("VALIDATION_ERROR", "缺少 supplier_ref 查询参数", { status: 400 });
      return ok({ orders: domain.listOrders(supplier_ref) });
    }],
    ["POST", "/orders/:id/batches", ({ params, body }) =>
      ok(domain.declareBatch({ ...body, order_id: params.id }), 201)],
    ["POST", "/batches/:ref/clear", ({ params }) => ok(domain.clearBatch(params.ref))],
    ["POST", "/batches/:ref/reject", ({ params }) => ok(domain.rejectBatch(params.ref))],
    ["GET", "/batches", ({ query }) => {
      const supplier_ref = query.get("supplier_ref");
      if (!supplier_ref) throw new DomainError("VALIDATION_ERROR", "缺少 supplier_ref 查询参数", { status: 400 });
      return ok({ batches: domain.listBatches(supplier_ref) });
    }],

    // ---------- 供应商门户（Bearer 令牌） ----------
    ["GET", "/portal", ({ request }) => {
      const supplier = domain.getSupplierByToken(bearerToken(request));
      return ok(domain.supplierPortal(supplier.supplier_ref));
    }],

    // ---------- 平台统计 ----------
    ["GET", "/stats", () => ok(domain.platformStats())],
  ];

  return defs.map(([method, pattern, handler]) => ({
    method,
    match: compilePattern(pattern),
    handler,
  }));
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer({ keepDbOpen: true }).listen(port, "0.0.0.0");
}

module.exports = { createServer };
