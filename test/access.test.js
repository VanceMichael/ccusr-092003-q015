
const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveDatabase } = require("../src/db");
const { createServer } = require("../src/server");

function digest(seed) {
  return require("node:crypto").createHash("sha256").update(seed).digest("hex");
}

async function withServer(run) {
  const database = resolveDatabase(":memory:");
  const server = createServer({ database });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const api = async (method, urlPath, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, init);
    const json = response.headers.get("content-type")?.includes("json")
      ? await response.json()
      : await response.text();
    return { status: response.status, body: json };
  };
  try {
    await run(api, database);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    database.close();
  }
}

const DOCS_V1 = [
  { item_code: "factory-questionnaire", document_ref: "DOC-Q", document_sha256: digest("q-v1") },
  { item_code: "haccp-cert", document_ref: "DOC-HACCP", document_sha256: digest("h-v1") },
];
const DOCS_V2 = [
  { item_code: "factory-questionnaire", document_ref: "DOC-Q", document_sha256: digest("q-v1") },
  { item_code: "haccp-cert", document_ref: "DOC-HACCP", document_sha256: digest("h-v2") },
  { item_code: "cold-chain-flow", document_ref: "DOC-COLD", document_sha256: digest("cold-v1") },
];

test("泰国冷冻榴莲：洽谈、补件、获准、首批通关到许可更新的完整接续", async () => {
  await withServer(async (api) => {
    // 目录
    assert.equal((await api("POST", "/categories", { code: "frozen-fruit", name: "冷冻水果" })).status, 201);
    assert.equal(
      (await api("POST", "/authorities", { code: "GACC", name: "海关总署" })).status,
      201
    );
    assert.equal(
      (
        await api("POST", "/suppliers", {
          ref: "SUPPLIER-TH-1",
          label: "泰国冷冻榴莲工厂",
          secret: "th-secret",
        })
      ).status,
      201
    );
    assert.equal(
      (
        await api("POST", "/facilities", {
          ref: "FACT-TH-1",
          supplier_ref: "SUPPLIER-TH-1",
          product_category: "frozen-fruit",
        })
      ).status,
      201
    );

    // 东博会洽谈：采购意向只是线索，不是获准
    let res = await api("POST", "/intentions", {
      ref: "INT-TH-1",
      supplier_ref: "SUPPLIER-TH-1",
      facility_ref: "FACT-TH-1",
      product_category: "frozen-fruit",
      scope_item: "frozen-durian-pulp",
      buyer_ref: "BUYER-CN-1",
      quantity_kg: 1200,
    });
    assert.equal(res.status, 201);

    res = await api("GET", "/gate?facility_ref=FACT-TH-1&product_category=frozen-fruit&scope_item=frozen-durian-pulp");
    assert.equal(res.body.status, "facility_unregistered");
    assert.equal(res.body.next_action, "await_facility_registration");

    // 买方确认
    res = await api("POST", "/intentions/INT-TH-1/confirm");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "confirmed");

    // 设施未注册：商机绝不能转成可履约订单
    res = await api("POST", "/intentions/INT-TH-1/fulfill", {});
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "facility_not_registered");
    assert.equal((await api("GET", "/orders")).body.orders.length, 0);

    // 展会与企业重复递交同一批材料：合并来源，不产生新版本
    res = await api("POST", "/documents", {
      supplier_ref: "SUPPLIER-TH-1",
      facility_ref: "FACT-TH-1",
      product_category: "frozen-fruit",
      submitted_via: "expo",
      source_ref: "EXPO-2026-HALL-3",
      documents: DOCS_V1,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.application_revision, 1);
    assert.equal(res.body.content_changed, true);

    res = await api("POST", "/documents", {
      supplier_ref: "SUPPLIER-TH-1",
      facility_ref: "FACT-TH-1",
      product_category: "frozen-fruit",
      submitted_via: "enterprise",
      source_ref: "ENTERPRISE-PORTAL",
      documents: DOCS_V1,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.content_changed, false);
    assert.equal(res.body.application_revision, 1);
    assert.deepEqual(res.body.merged_source, {
      submitted_via: "enterprise",
      source_ref: "ENTERPRISE-PORTAL",
    });

    // 主管机关提出补件：下一步是补材料
    res = await api("POST", "/supplements", {
      supplier_ref: "SUPPLIER-TH-1",
      facility_ref: "FACT-TH-1",
      product_category: "frozen-fruit",
      item_code: "cold-chain-flow",
      detail: "需补充冷链温控流程",
    });
    assert.equal(res.status, 201);
    res = await api("GET", "/gate?facility_ref=FACT-TH-1&product_category=frozen-fruit&scope_item=frozen-durian-pulp");
    assert.equal(res.body.status, "facility_unregistered"); // 未注册仍优先阻断

    // 设施注册但尚未批准：闸门要求补材料
    assert.equal((await api("POST", "/facilities/FACT-TH-1/register")).status, 200);
    res = await api("GET", "/gate?facility_ref=FACT-TH-1&product_category=frozen-fruit&scope_item=frozen-durian-pulp");
    assert.equal(res.body.status, "approval_not_in_force");
    assert.equal(res.body.next_action, "supplement_documents");
    assert.equal(res.body.pending_supplements[0].item_code, "cold-chain-flow");

    // 已确认意向在无有效批准时仍不能履约
    res = await api("POST", "/intentions/INT-TH-1/fulfill", {});
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "approval_not_in_force");

    // 补件以材料修订 v2 递交，补件请求自动核销，版本号升到 2
    res = await api("POST", "/documents", {
      supplier_ref: "SUPPLIER-TH-1",
      facility_ref: "FACT-TH-1",
      product_category: "frozen-fruit",
      submitted_via: "enterprise",
      source_ref: "ENTERPRISE-PORTAL",
      documents: DOCS_V2,
    });
    assert.equal(res.body.application_revision, 2);
    assert.equal(res.body.content_changed, true);
    assert.deepEqual(res.body.resolved_supplements, [
      { item_code: "cold-chain-flow", application_revision: 2 },
    ]);

    // 首批许可：仅覆盖冻榴莲果肉，自 2026-01-01 生效
    res = await api("POST", "/approvals", {
      facility_ref: "FACT-TH-1",
      product_category: "frozen-fruit",
      authority_code: "GACC",
      scope_items: ["frozen-durian-pulp"],
      scope_summary: "冷冻榴莲果肉",
      effective_from: "2026-01-01T00:00:00Z",
    });
    assert.equal(res.status, 201);
    const approval1 = res.body;
    assert.deepEqual(approval1.approval_scope, ["frozen-durian-pulp"]);

    res = await api("GET", "/gate?facility_ref=FACT-TH-1&product_category=frozen-fruit&scope_item=frozen-durian-pulp");
    assert.equal(res.body.status, "ready");
    assert.equal(res.body.next_action, "arrange_first_shipment");

    // 超范围货物（整粒 Monthong 不在首批许可内）不能履约
    res = await api("POST", "/intentions", {
      ref: "INT-TH-2",
      supplier_ref: "SUPPLIER-TH-1",
      facility_ref: "FACT-TH-1",
      product_category: "frozen-fruit",
      scope_item: "frozen-monthong-whole",
      buyer_ref: "BUYER-CN-2",
      quantity_kg: 800,
    });
    assert.equal(res.status, 201);
    await api("POST", "/intentions/INT-TH-2/confirm");
    res = await api("POST", "/intentions/INT-TH-2/fulfill", {});
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "approval_not_in_force");

    // 范围内商机转可履约订单，固化所依据的批准
    res = await api("POST", "/intentions/INT-TH-1/fulfill", {});
    assert.equal(res.status, 201);
    const order1 = res.body;
    assert.equal(order1.approval_id, approval1.id);
    // 幂等：重复履约返回同一订单
    res = await api("POST", "/intentions/INT-TH-1/fulfill", {});
    assert.equal(res.body.ref, order1.ref);

    // 首批通关：订舱按计划日期过闸并固化批准快照，随后实际通关
    res = await api("POST", "/shipments", {
      order_ref: order1.ref,
      shipment_ref: "SHP-TH-1",
      planned_at: "2026-02-10T08:00:00Z",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.approval_id, approval1.id);
    assert.equal(res.body.status, "booked");
    res = await api("POST", "/shipments/SHP-TH-1/clear");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "cleared");

    // 许可更新：扩范围（新增整粒 Monthong），3 月起生效并作废旧许可窗口
    res = await api("POST", "/approvals", {
      facility_ref: "FACT-TH-1",
      product_category: "frozen-fruit",
      authority_code: "GACC",
      scope_items: ["frozen-durian-pulp", "frozen-monthong-whole"],
      scope_summary: "冷冻榴莲果肉及整粒 Monthong",
      effective_from: "2026-03-01T00:00:00Z",
      supersedes_id: approval1.id,
    });
    assert.equal(res.status, 201);
    const approval2 = res.body;

    // 旧批次快照不受影响
    res = await api("GET", "/shipments?status=cleared");
    assert.equal(res.body.shipments[0].approval_id, approval1.id);

    // 许可更新只影响适用的新批次：3 月前的整粒榴莲订舱仍被拒
    res = await api("POST", "/intentions/INT-TH-2/fulfill", {});
    assert.equal(res.status, 201);
    const order2 = res.body;
    res = await api("POST", "/shipments", {
      order_ref: order2.ref,
      shipment_ref: "SHP-TH-2-EARLY",
      planned_at: "2026-02-15T08:00:00Z",
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "shipment_outside_approval");
    // 3 月后订舱适用新许可
    res = await api("POST", "/shipments", {
      order_ref: order2.ref,
      shipment_ref: "SHP-TH-2",
      planned_at: "2026-03-05T08:00:00Z",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.approval_id, approval2.id);
    // 同一订单 3 月后的后续批次同样挂新许可
    res = await api("POST", "/shipments", {
      order_ref: order1.ref,
      shipment_ref: "SHP-TH-3",
      planned_at: "2026-03-20T08:00:00Z",
    });
    assert.equal(res.body.approval_id, approval2.id);
    await api("POST", "/shipments/SHP-TH-2/clear");
    await api("POST", "/shipments/SHP-TH-3/clear");

    // 供应商门户：登录后看到补件、有效许可与买方确认
    res = await api("GET", "/suppliers/SUPPLIER-TH-1/portal");
    assert.equal(res.status, 401);
    res = await api("GET", "/suppliers/SUPPLIER-TH-1/portal", undefined, {
      "x-supplier-secret": "wrong",
    });
    assert.equal(res.status, 401);
    res = await api("GET", "/suppliers/SUPPLIER-TH-1/portal", undefined, {
      "x-supplier-secret": "th-secret",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.pending_supplements.length, 0);
    assert.equal(res.body.resolved_supplements[0].item_code, "cold-chain-flow");
    assert.equal(res.body.resolved_supplements[0].status, "submitted");
    const portalApprovals = res.body.valid_approvals.map((item) => item.id);
    assert.ok(portalApprovals.includes(approval2.id));
    assert.ok(!portalApprovals.includes(approval1.id), "旧许可已在新生效日关闭");
    assert.deepEqual(
      res.body.buyer_confirmations.map((item) => item.intention_ref).sort(),
      ["INT-TH-1", "INT-TH-2"]
    );
    assert.equal(
      res.body.buyer_confirmations.find((item) => item.intention_ref === "INT-TH-1").order_ref,
      order1.ref
    );

    // 平台统计：洽谈 / 获准企业 / 实际通关 / 复购 明确区分
    res = await api("GET", "/stats");
    assert.equal(res.status, 200);
    assert.equal(res.body.talks.total, 2);
    assert.equal(res.body.talks.confirmed, 2);
    assert.equal(res.body.approved.suppliers, 1);
    assert.equal(res.body.approved.facilities, 1);
    assert.equal(res.body.fulfilled_orders, 2);
    assert.equal(res.body.customs.cleared_shipments, 3);
    assert.equal(res.body.customs.cleared_suppliers, 1);
    // BUYER-CN-1 通关 2 批（SHP-TH-1、SHP-TH-3）构成复购；BUYER-CN-2 仅 1 批
    assert.equal(res.body.repeat.repeat_buyers, 1);
    assert.equal(res.body.repeat.repeat_shipments, 1);
  });
});

test("越南燕窝：买方退出仅释放未确认需求，超批准范围无法履约", async () => {
  await withServer(async (api) => {
    await api("POST", "/categories", { code: "bird-nest", name: "燕窝" });
    await api("POST", "/authorities", { code: "GACC", name: "海关总署" });
    await api("POST", "/suppliers", {
      ref: "SUPPLIER-VN-1",
      label: "越南燕窝企业",
      secret: "vn-secret",
    });
    await api("POST", "/facilities", {
      ref: "FACT-VN-1",
      supplier_ref: "SUPPLIER-VN-1",
      product_category: "bird-nest",
    });

    // 线索一：买方在确认前退出，需求被释放
    let res = await api("POST", "/intentions", {
      ref: "INT-VN-1",
      supplier_ref: "SUPPLIER-VN-1",
      facility_ref: "FACT-VN-1",
      product_category: "bird-nest",
      scope_item: "raw-bird-nest",
      buyer_ref: "BUYER-CN-3",
      quantity_kg: 50,
    });
    assert.equal(res.status, 201);
    res = await api("POST", "/intentions/INT-VN-1/withdraw");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "withdrawn");
    // 已退出的意向不能履约
    res = await api("POST", "/intentions/INT-VN-1/fulfill", {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "intention_withdrawn");

    // 线索二：买方确认后不可退出
    res = await api("POST", "/intentions", {
      ref: "INT-VN-2",
      supplier_ref: "SUPPLIER-VN-1",
      facility_ref: "FACT-VN-1",
      product_category: "bird-nest",
      scope_item: "raw-bird-nest",
      buyer_ref: "BUYER-CN-4",
      quantity_kg: 60,
    });
    await api("POST", "/intentions/INT-VN-2/confirm");
    res = await api("POST", "/intentions/INT-VN-2/withdraw");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "buyer_commitment_locked");

    // 设施注册，许可只覆盖“加工燕窝”，不覆盖意向中的“毛燕”
    await api("POST", "/facilities/FACT-VN-1/register");
    // 材料已递交（展会收件），不存在待补件
    await api("POST", "/documents", {
      supplier_ref: "SUPPLIER-VN-1",
      facility_ref: "FACT-VN-1",
      product_category: "bird-nest",
      submitted_via: "expo",
      source_ref: "EXPO-2026-HALL-1",
      documents: [
        { item_code: "factory-questionnaire", document_ref: "VN-DOC-1", document_sha256: digest("vn-d1") },
      ],
    });
    res = await api("POST", "/approvals", {
      facility_ref: "FACT-VN-1",
      product_category: "bird-nest",
      authority_code: "GACC",
      scope_items: ["processed-bird-nest"],
      effective_from: "2026-01-01T00:00:00Z",
    });
    assert.equal(res.status, 201);

    res = await api("GET", "/gate?facility_ref=FACT-VN-1&product_category=bird-nest&scope_item=raw-bird-nest");
    assert.equal(res.body.status, "approval_not_in_force");
    assert.equal(res.body.next_action, "await_approval"); // 材料齐、无补件，只能等扩范围批准
    res = await api("POST", "/intentions/INT-VN-2/fulfill", {});
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "approval_not_in_force");
    assert.equal((await api("GET", "/orders")).body.orders.length, 0);

    // 未确认的第三条线索仍可正常退出释放
    await api("POST", "/intentions", {
      ref: "INT-VN-3",
      supplier_ref: "SUPPLIER-VN-1",
      facility_ref: "FACT-VN-1",
      product_category: "bird-nest",
      scope_item: "processed-bird-nest",
      buyer_ref: "BUYER-CN-5",
      quantity_kg: 30,
    });
    res = await api("POST", "/intentions/INT-VN-3/withdraw");
    assert.equal(res.status, 200);

    // 洽谈数包含退出线索，但获准/通关不因此虚增；“见过采购商”不等于获准
    res = await api("GET", "/stats");
    assert.equal(res.body.talks.total, 3);
    assert.equal(res.body.talks.open, 0);
    assert.equal(res.body.talks.confirmed, 1);
    assert.equal(res.body.talks.withdrawn, 2);
    assert.equal(res.body.approved.suppliers, 1); // 设施获准的是加工燕窝，毛燕商机仍不能转单
    assert.equal(res.body.fulfilled_orders, 0);
    assert.equal(res.body.customs.cleared_shipments, 0);
  });
});

test("未确认意向不能履约，设施与类别必须匹配", async () => {
  await withServer(async (api) => {
    await api("POST", "/categories", { code: "frozen-fruit", name: "冷冻水果" });
    await api("POST", "/categories", { code: "bird-nest", name: "燕窝" });
    await api("POST", "/authorities", { code: "GACC", name: "海关总署" });
    await api("POST", "/suppliers", { ref: "S1", label: "供应商一", secret: "s1" });
    await api("POST", "/facilities", {
      ref: "F1",
      supplier_ref: "S1",
      product_category: "frozen-fruit",
    });

    let res = await api("POST", "/intentions", {
      ref: "INT-X1",
      supplier_ref: "S1",
      facility_ref: "F1",
      product_category: "bird-nest", // 设施不生产该类别
      scope_item: "raw-bird-nest",
      buyer_ref: "B1",
      quantity_kg: 10,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "facility_category_mismatch");

    res = await api("POST", "/intentions", {
      ref: "INT-X2",
      supplier_ref: "S1",
      facility_ref: "F1",
      product_category: "frozen-fruit",
      scope_item: "frozen-durian-pulp",
      buyer_ref: "B1",
      quantity_kg: 10,
    });
    assert.equal(res.status, 201);
    // 未确认直接履约被拒
    res = await api("POST", "/intentions/INT-X2/fulfill", {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "intention_not_confirmed");

    // 材料夹接口暴露当前 application_revision
    res = await api("POST", "/documents", {
      supplier_ref: "S1",
      facility_ref: "F1",
      product_category: "frozen-fruit",
      submitted_via: "expo",
      source_ref: "EXPO-DESK",
      documents: [
        { item_code: "factory-questionnaire", document_ref: "D1", document_sha256: digest("d1") },
      ],
    });
    assert.equal(res.status, 201);
    res = await api("GET", "/document-bundles?supplier_ref=S1");
    assert.equal(res.body.bundles[0].application_revision, 1);
  });
});
