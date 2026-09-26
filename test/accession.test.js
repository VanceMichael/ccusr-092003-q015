"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createServer } = require("../src/server");
const { runMigrations } = require("../src/db");

// 每个用例使用独立内存库，经完整 HTTP 栈验证状态机与门禁。
async function startContext() {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const server = createServer({ db, keepDbOpen: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function api(method, path, body, token) {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    return { status: response.status, body: json };
  }

  async function seed() {
    await api("PUT", "/categories/frozen-fruit", { name: "冷冻水果", hs_codes: ["0811"] });
    await api("PUT", "/categories/edible-birdnest", { name: "食用燕窝", hs_codes: ["0410"] });
    await api("PUT", "/authorities/AUTH-TH", { name: "泰国主管机关示例", country_code: "TH" });
    await api("PUT", "/authorities/AUTH-VN", { name: "越南主管机关示例", country_code: "VN" });
    await api("PUT", "/suppliers/SUP-TH", {
      display_name: "泰国冷冻榴莲工厂",
      country_code: "TH",
      access_token: "token-th",
    });
    await api("PUT", "/suppliers/SUP-VN", {
      display_name: "越南燕窝企业",
      country_code: "VN",
      access_token: "token-vn",
    });
    await api("PUT", "/facilities/FAC-TH", {
      supplier_ref: "SUP-TH",
      name: "尖竹汶冷冻厂",
      country_code: "TH",
    });
    await api("PUT", "/facilities/FAC-VN", {
      supplier_ref: "SUP-VN",
      name: "庆和燕窝厂",
      country_code: "VN",
    });
  }

  return {
    api,
    seed,
    stop: async () => {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

test("重复材料合并来源：同摘要只追加来源、不抬版本；新摘要升版本", async (context) => {
  const ctx = await startContext();
  context.after(ctx.stop);
  await ctx.seed();

  const hash = "sha256:same-content";
  const payload = (channel, source_ref) => ({
    supplier_ref: "SUP-TH",
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    doc_type: "haccp-certificate",
    content_hash: hash,
    source: { channel, source_ref },
  });

  const first = await ctx.api("POST", "/materials", payload("expo", "BOOTH-17"));
  assert.equal(first.status, 201);
  assert.equal(first.body.merged, false);
  assert.equal(first.body.material.revision, 1);

  const dup = await ctx.api("POST", "/materials", payload("enterprise", "mail:0920"));
  assert.equal(dup.status, 200);
  assert.equal(dup.body.merged, true);
  assert.equal(dup.body.material.material_id, first.body.material.material_id);
  assert.equal(dup.body.material.revision, 1);
  assert.deepEqual(
    dup.body.material.sources.map((s) => s.source_channel),
    ["expo", "enterprise"],
  );

  const listed = await ctx.api("GET", "/materials?supplier_ref=SUP-TH");
  assert.equal(listed.body.materials.length, 1, "内容只保存一份");

  const revised = await ctx.api("POST", "/materials", {
    ...payload("enterprise", "mail:0925"),
    content_hash: "sha256:new-content",
  });
  assert.equal(revised.status, 201);
  assert.equal(revised.body.material.revision, 2, "内容变化才产生新版本");
});

test("设施未注册：商机绝不能转成可履约订单", async (context) => {
  const ctx = await startContext();
  context.after(ctx.stop);
  await ctx.seed();

  const created = await ctx.api("POST", "/intentions", {
    buyer_ref: "BUYER-A",
    supplier_ref: "SUP-VN",
    facility_ref: "FAC-VN",
    product_category: "edible-birdnest",
    hs_code: "04100090",
    form: "cleaned",
    quantity: 100,
  });
  assert.equal(created.status, 201);
  const id = created.body.intention_id;

  await ctx.api("POST", `/intentions/${id}/confirm`);
  const blocked = await ctx.api("POST", `/intentions/${id}/convert`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, "FACILITY_NOT_REGISTERED");

  const orders = await ctx.api("GET", "/orders?supplier_ref=SUP-VN");
  assert.equal(orders.body.orders.length, 0);
});

test("货物超出批准范围：即使设施已注册也不能转单", async (context) => {
  const ctx = await startContext();
  context.after(ctx.stop);
  await ctx.seed();

  await ctx.api("POST", "/registrations/mark-registered", {
    facility_ref: "FAC-TH",
    authority_ref: "AUTH-TH",
  });
  const approval = await ctx.api("POST", "/approvals", {
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    authority_ref: "AUTH-TH",
    scope: { hs_codes: ["0811"], forms: ["frozen-pulp"] },
  });
  assert.equal(approval.status, 201);
  assert.equal(approval.body.version, 1);

  // 整果不在批准形态内。
  const whole = await ctx.api("POST", "/intentions", {
    buyer_ref: "BUYER-B",
    supplier_ref: "SUP-TH",
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    hs_code: "08119000",
    form: "whole-frozen",
    quantity: 5,
  });
  await ctx.api("POST", `/intentions/${whole.body.intention_id}/confirm`);
  const blocked = await ctx.api("POST", `/intentions/${whole.body.intention_id}/convert`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, "OUT_OF_APPROVAL_SCOPE");

  // 果肉在上位税目 0811 覆盖范围内，可以转单。
  const pulp = await ctx.api("POST", "/intentions", {
    buyer_ref: "BUYER-A",
    supplier_ref: "SUP-TH",
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    hs_code: "08119000",
    form: "frozen-pulp",
    quantity: 18,
  });
  await ctx.api("POST", `/intentions/${pulp.body.intention_id}/confirm`);
  const converted = await ctx.api("POST", `/intentions/${pulp.body.intention_id}/convert`);
  assert.equal(converted.status, 201);
  assert.equal(converted.body.approval.version, 1);
});

test("许可更新只影响新批次：已申报批次冻结旧版本", async (context) => {
  const ctx = await startContext();
  context.after(ctx.stop);
  await ctx.seed();

  await ctx.api("POST", "/registrations/mark-registered", {
    facility_ref: "FAC-TH",
    authority_ref: "AUTH-TH",
  });
  await ctx.api("POST", "/approvals", {
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    authority_ref: "AUTH-TH",
    scope: { hs_codes: ["0811"], forms: ["frozen-pulp", "whole-frozen"] },
  });

  const intention = await ctx.api("POST", "/intentions", {
    buyer_ref: "BUYER-A",
    supplier_ref: "SUP-TH",
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    hs_code: "08119000",
    form: "whole-frozen",
    quantity: 10,
  });
  await ctx.api("POST", `/intentions/${intention.body.intention_id}/confirm`);
  const order = await ctx.api("POST", `/intentions/${intention.body.intention_id}/convert`);
  const orderId = order.body.order.order_id;
  const v1Approval = order.body.approval.approval_id;

  // 首批 4 吨，冻结 v1。
  const batch1 = await ctx.api("POST", `/orders/${orderId}/batches`, {
    hs_code: "08119000",
    form: "whole-frozen",
    quantity: 4,
  });
  assert.equal(batch1.status, 201);
  assert.equal(batch1.body.approval_id, v1Approval);

  // 许可更新：v2 扩围（此处演示形态不变、版本递增）。
  const renewed = await ctx.api("POST", "/approvals", {
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    authority_ref: "AUTH-TH",
    scope: { hs_codes: ["0811", "0812"], forms: ["frozen-pulp", "whole-frozen"] },
  });
  assert.equal(renewed.body.version, 2);

  // 第二批按新批准申报，冻结 v2；首批不受影响。
  const batch2 = await ctx.api("POST", `/orders/${orderId}/batches`, {
    hs_code: "08119000",
    form: "whole-frozen",
    quantity: 6,
  });
  assert.equal(batch2.status, 201);
  assert.notEqual(batch2.body.approval_id, v1Approval);

  const batches = await ctx.api("GET", "/batches?supplier_ref=SUP-TH");
  assert.equal(batches.body.batches[1].approval_id, v1Approval);
  assert.notEqual(batches.body.batches[0].approval_id, v1Approval);

  // 累计超量被拒。
  const overflow = await ctx.api("POST", `/orders/${orderId}/batches`, {
    hs_code: "08119000",
    form: "whole-frozen",
    quantity: 1,
  });
  assert.equal(overflow.status, 409);
});

test("买方退出仅释放尚未确认的需求", async (context) => {
  const ctx = await startContext();
  context.after(ctx.stop);
  await ctx.seed();

  const negotiating = await ctx.api("POST", "/intentions", {
    buyer_ref: "BUYER-A",
    supplier_ref: "SUP-TH",
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    hs_code: "08119000",
    form: "frozen-pulp",
    quantity: 3,
  });
  const withdrawn = await ctx.api("POST", `/intentions/${negotiating.body.intention_id}/withdraw`);
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.status, "withdrawn");

  // 已确认意向不能撤回。
  const firm = await ctx.api("POST", "/intentions", {
    buyer_ref: "BUYER-B",
    supplier_ref: "SUP-TH",
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    hs_code: "08119000",
    form: "frozen-pulp",
    quantity: 3,
  });
  await ctx.api("POST", `/intentions/${firm.body.intention_id}/confirm`);
  const refused = await ctx.api("POST", `/intentions/${firm.body.intention_id}/withdraw`);
  assert.equal(refused.status, 409);
});

test("供应商门户：登录后看到补件、有效许可与买方确认", async (context) => {
  const ctx = await startContext();
  context.after(ctx.stop);
  await ctx.seed();

  const unauthorized = await ctx.api("GET", "/portal");
  assert.equal(unauthorized.status, 401);

  const material = await ctx.api("POST", "/materials", {
    supplier_ref: "SUP-TH",
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    doc_type: "haccp-certificate",
    content_hash: "sha256:abc",
    source: { channel: "expo", source_ref: "BOOTH-1" },
  });
  await ctx.api("POST", `/materials/${material.body.material.material_id}/supplement-requests`, {
    detail: "请补充冷链温度记录",
  });
  await ctx.api("POST", "/registrations/mark-registered", {
    facility_ref: "FAC-TH",
    authority_ref: "AUTH-TH",
  });
  await ctx.api("POST", "/approvals", {
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    authority_ref: "AUTH-TH",
    scope: { hs_codes: ["0811"], forms: ["frozen-pulp"] },
  });
  const intention = await ctx.api("POST", "/intentions", {
    buyer_ref: "BUYER-A",
    supplier_ref: "SUP-TH",
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    hs_code: "08119000",
    form: "frozen-pulp",
    quantity: 9,
  });
  await ctx.api("POST", `/intentions/${intention.body.intention_id}/confirm`);

  const portal = await ctx.api("GET", "/portal", undefined, "token-th");
  assert.equal(portal.status, 200);
  assert.equal(portal.body.supplement_requests.length, 1);
  assert.equal(portal.body.supplement_requests[0].status, "open");
  assert.equal(portal.body.active_approvals.length, 1);
  assert.equal(portal.body.active_approvals[0].scope.forms[0], "frozen-pulp");
  assert.equal(portal.body.buyer_confirmations.length, 1);
  assert.equal(portal.body.buyer_confirmations[0].status, "confirmed");

  // 补件后材料新版递交，补件请求自动办结。
  await ctx.api("POST", "/materials", {
    supplier_ref: "SUP-TH",
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    doc_type: "haccp-certificate",
    content_hash: "sha256:def",
    source: { channel: "enterprise", source_ref: "mail:0926" },
  });
  const after = await ctx.api("GET", "/portal", undefined, "token-th");
  assert.equal(after.body.supplement_requests[0].status, "resolved");
});

test("平台统计区分洽谈、获准企业、实际通关与复购", async (context) => {
  const ctx = await startContext();
  context.after(ctx.stop);
  await ctx.seed();

  // 仅洽谈：越南燕窝厂，见过采购商但未获准。
  const talk = await ctx.api("POST", "/intentions", {
    buyer_ref: "BUYER-X",
    supplier_ref: "SUP-VN",
    facility_ref: "FAC-VN",
    product_category: "edible-birdnest",
    hs_code: "04100090",
    form: "cleaned",
    quantity: 50,
  });
  await ctx.api("POST", `/intentions/${talk.body.intention_id}/withdraw`);
  const talk2 = await ctx.api("POST", "/intentions", {
    buyer_ref: "BUYER-Y",
    supplier_ref: "SUP-VN",
    facility_ref: "FAC-VN",
    product_category: "edible-birdnest",
    hs_code: "04100090",
    form: "cleaned",
    quantity: 30,
  });
  assert.equal(talk2.status, 201);

  // 泰国厂获准并与 BUYER-A 完成两笔订单清关（复购）。
  await ctx.api("POST", "/registrations/mark-registered", {
    facility_ref: "FAC-TH",
    authority_ref: "AUTH-TH",
  });
  await ctx.api("POST", "/approvals", {
    facility_ref: "FAC-TH",
    product_category: "frozen-fruit",
    authority_ref: "AUTH-TH",
    scope: { hs_codes: ["0811"], forms: ["frozen-pulp"] },
  });

  async function placeAndClear(qty) {
    const intention = await ctx.api("POST", "/intentions", {
      buyer_ref: "BUYER-A",
      supplier_ref: "SUP-TH",
      facility_ref: "FAC-TH",
      product_category: "frozen-fruit",
      hs_code: "08119000",
      form: "frozen-pulp",
      quantity: qty,
    });
    await ctx.api("POST", `/intentions/${intention.body.intention_id}/confirm`);
    const order = await ctx.api("POST", `/intentions/${intention.body.intention_id}/convert`);
    const batch = await ctx.api("POST", `/orders/${order.body.order.order_id}/batches`, {
      hs_code: "08119000",
      form: "frozen-pulp",
      quantity: qty,
    });
    await ctx.api("POST", `/batches/${batch.body.batch_ref}/clear`);
    return order.body.order;
  }

  await placeAndClear(9);
  await placeAndClear(6);

  const stats = (await ctx.api("GET", "/stats")).body;
  // 洽谈：一笔 withdrawn 不计入 negotiating，一笔在洽。
  assert.equal(stats.discussions.negotiating_intentions, 1);
  assert.equal(stats.discussions.distinct_buyers, 1);
  // 获准企业：仅泰国厂。
  assert.equal(stats.admitted_enterprises.suppliers, 1);
  assert.equal(stats.admitted_enterprises.active_approvals, 1);
  // 实际通关：两批、一个供应商、两笔订单。
  assert.equal(stats.actual_customs.cleared_batches, 2);
  assert.equal(stats.actual_customs.distinct_suppliers, 1);
  assert.equal(stats.actual_customs.converted_orders, 2);
  // 复购：BUYER-A 与 SUP-TH 之间两笔清关订单。
  assert.equal(stats.repeat_purchases.buyer_supplier_pairs, 1);
  assert.equal(stats.repeat_purchases.pairs[0].buyer_ref, "BUYER-A");
});
