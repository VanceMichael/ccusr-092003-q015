
const http = require("node:http");
const { URL } = require("node:url");
const { resolveDatabase } = require("./db");
const domain = require("./domain");

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new domain.ApiError(413, "body_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("body must be a JSON object");
        }
        resolve(parsed);
      } catch {
        reject(new domain.ApiError(400, "invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

// 供应商登录：门户密钥经 x-supplier-secret 传递，服务端只比对 sha256 摘要
function requirePortalAuth(database, request, supplierRef) {
  const secret = request.headers["x-supplier-secret"];
  domain.authenticateSupplier(database, supplierRef, secret);
}

function createServer(options = {}) {
  const database = options.database ?? resolveDatabase();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams);

    const route = (method, pattern) => {
      if (request.method !== method) return null;
      const names = [];
      const regex = new RegExp(
        `^${pattern
          .replace(/\/+$/g, "")
          .replace(/:[^/]+/g, (match) => {
            names.push(match.slice(1));
            return "([^/]+)";
          })}\/?$`
      );
      const result = regex.exec(path.replace(/\/+$/, "") || "/");
      if (!result) return null;
      const params = {};
      names.forEach((name, index) => {
        params[name] = decodeURIComponent(result[index + 1]);
      });
      return params;
    };

    try {
      if (request.method === "GET" && path === "/health") {
        send(response, 200, { status: "ok" });
        return;
      }

      // 目录数据
      let params;
      if (request.method === "POST" && path === "/categories") {
        send(response, 201, domain.createCategory(database, await readBody(request)));
        return;
      }
      if (request.method === "GET" && path === "/categories") {
        send(response, 200, { categories: domain.listCategories(database) });
        return;
      }
      if (request.method === "POST" && path === "/authorities") {
        send(response, 201, domain.createAuthority(database, await readBody(request)));
        return;
      }
      if (request.method === "GET" && path === "/authorities") {
        send(response, 200, { authorities: domain.listAuthorities(database) });
        return;
      }
      if (request.method === "POST" && path === "/suppliers") {
        send(response, 201, domain.registerSupplier(database, await readBody(request)));
        return;
      }
      if (request.method === "GET" && path === "/suppliers") {
        send(response, 200, { suppliers: domain.listSuppliers(database) });
        return;
      }
      if (request.method === "POST" && path === "/facilities") {
        send(response, 201, domain.registerFacility(database, await readBody(request)));
        return;
      }
      if (request.method === "GET" && path === "/facilities") {
        send(response, 200, { facilities: domain.listFacilities(database, query.supplier_ref) });
        return;
      }
      if ((params = route("POST", "/facilities/:ref/register"))) {
        send(response, 200, domain.markFacilityRegistered(database, params.ref));
        return;
      }

      // 材料版本、来源合并与补件
      if (request.method === "POST" && path === "/documents") {
        send(response, 201, domain.submitDocuments(database, await readBody(request)));
        return;
      }
      if (request.method === "GET" && path === "/document-bundles") {
        send(response, 200, { bundles: domain.listBundles(database, query.supplier_ref) });
        return;
      }
      if (request.method === "POST" && path === "/supplements") {
        send(response, 201, domain.requestSupplement(database, await readBody(request)));
        return;
      }
      if (request.method === "GET" && path === "/supplements") {
        send(
          response,
          200,
          {
            supplements: domain.listSupplements(database, {
              supplierRef: query.supplier_ref,
              status: query.status,
            }),
          }
        );
        return;
      }

      // 批准与闸门
      if (request.method === "POST" && path === "/approvals") {
        send(response, 201, domain.grantApproval(database, await readBody(request)));
        return;
      }
      if (request.method === "GET" && path === "/approvals") {
        send(response, 200, { approvals: domain.listApprovals(database, query.facility_ref) });
        return;
      }
      if (request.method === "GET" && path === "/gate") {
        send(
          response,
          200,
          domain.evaluateGate(database, {
            facility_ref: query.facility_ref,
            product_category: query.product_category,
            scope_item: query.scope_item,
            at: query.at,
          })
        );
        return;
      }

      // 采购意向
      if (request.method === "POST" && path === "/intentions") {
        send(response, 201, domain.createIntention(database, await readBody(request)));
        return;
      }
      if (request.method === "GET" && path === "/intentions") {
        send(
          response,
          200,
          {
            intentions: domain.listIntentions(database, {
              supplierRef: query.supplier_ref,
              buyerRef: query.buyer_ref,
              status: query.status,
              includeGate: query.gate === "1",
            }),
          }
        );
        return;
      }
      if ((params = route("GET", "/intentions/:ref"))) {
        send(
          response,
          200,
          domain.getIntention(database, params.ref, { includeGate: query.gate === "1" })
        );
        return;
      }
      if ((params = route("POST", "/intentions/:ref/confirm"))) {
        send(response, 200, domain.confirmIntention(database, params.ref));
        return;
      }
      if ((params = route("POST", "/intentions/:ref/withdraw"))) {
        send(response, 200, domain.withdrawIntention(database, params.ref));
        return;
      }
      if ((params = route("POST", "/intentions/:ref/fulfill"))) {
        const body = await readBody(request);
        send(response, 201, domain.fulfillIntention(database, params.ref, { at: body.at }));
        return;
      }

      // 可履约订单
      if (request.method === "GET" && path === "/orders") {
        send(
          response,
          200,
          { orders: domain.listOrders(database, { supplierRef: query.supplier_ref, buyerRef: query.buyer_ref }) }
        );
        return;
      }

      // 通关批次
      if (request.method === "POST" && path === "/shipments") {
        send(response, 201, domain.bookShipment(database, await readBody(request)));
        return;
      }
      if (request.method === "GET" && path === "/shipments") {
        send(
          response,
          200,
          {
            shipments: domain.listShipments(database, {
              supplierRef: query.supplier_ref,
              buyerRef: query.buyer_ref,
              status: query.status,
            }),
          }
        );
        return;
      }
      if ((params = route("POST", "/shipments/:ref/clear"))) {
        send(response, 200, domain.clearShipment(database, params.ref));
        return;
      }

      // 供应商门户（需登录）
      if ((params = route("GET", "/suppliers/:ref/portal"))) {
        requirePortalAuth(database, request, params.ref);
        send(response, 200, domain.supplierPortal(database, params.ref));
        return;
      }

      // 平台统计
      if (request.method === "GET" && path === "/stats") {
        send(response, 200, domain.platformStats(database));
        return;
      }

      send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof domain.ApiError) {
        send(response, error.status, { error: error.code, details: error.details });
        return;
      }
      send(response, 500, { error: "internal_error" });
    }
  });

  server.on("close", () => {
    if (!options.database) database.close();
  });

  return server;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0");
}

module.exports = { createServer };
