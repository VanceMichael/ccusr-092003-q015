
const crypto = require("node:crypto");

// 供应商准入接续领域服务。
// 阶段闸门（不可跨越）：
//   洽谈意向 --(买方确认)--> 已确认意向 --(设施已注册 + 批准在范围内且生效)--> 可履约订单
//   --(订舱时按计划日期再次过闸并固化批准快照)--> 通关批次 --> 复购
// 设施未注册或货物超出批准范围，商机一律不能转成可履约订单。

class ApiError extends Error {
  constructor(status, code, details = undefined) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function randomRef(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString("hex")}`.toUpperCase();
}

function parseIso(value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, "invalid_time", { field });
  }
  return new Date(value).toISOString();
}

function requireBody(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null);
  if (missing.length > 0) throw new ApiError(400, "missing_fields", { fields: missing });
}

function transaction(database, work) {
  database.exec("BEGIN");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

// ---------- 目录数据：类别 / 主管机关 / 供应商 / 设施 ----------

function createCategory(database, body) {
  requireBody(body, ["code", "name"]);
  try {
    database
      .prepare(
        `INSERT INTO product_categories(code, name, default_authority_code, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(body.code, body.name, body.default_authority_code ?? null, nowIso());
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throw new ApiError(409, "category_exists");
    }
    throw error;
  }
  return getCategory(database, body.code);
}

function getCategory(database, code) {
  const row = database.prepare("SELECT * FROM product_categories WHERE code = ?").get(code);
  if (!row) throw new ApiError(404, "category_not_found");
  return row;
}

function listCategories(database) {
  return database.prepare("SELECT * FROM product_categories ORDER BY code").all();
}

function createAuthority(database, body) {
  requireBody(body, ["code", "name"]);
  try {
    database
      .prepare("INSERT INTO competent_authorities(code, name, created_at) VALUES (?, ?, ?)")
      .run(body.code, body.name, nowIso());
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throw new ApiError(409, "authority_exists");
    }
    throw error;
  }
  return database.prepare("SELECT * FROM competent_authorities WHERE code = ?").get(body.code);
}

function listAuthorities(database) {
  return database.prepare("SELECT * FROM competent_authorities ORDER BY code").all();
}

function registerSupplier(database, body) {
  requireBody(body, ["ref", "label", "secret"]);
  try {
    database
      .prepare("INSERT INTO suppliers(ref, label, secret_sha256, created_at) VALUES (?, ?, ?, ?)")
      .run(body.ref, body.label, sha256(String(body.secret)), nowIso());
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throw new ApiError(409, "supplier_exists");
    }
    throw error;
  }
  return getSupplier(database, body.ref);
}

function getSupplier(database, ref) {
  const row = database.prepare("SELECT ref, label, created_at FROM suppliers WHERE ref = ?").get(ref);
  if (!row) throw new ApiError(404, "supplier_not_found");
  return row;
}

function authenticateSupplier(database, ref, secret) {
  const row = database.prepare("SELECT secret_sha256 FROM suppliers WHERE ref = ?").get(ref);
  const expected = row ? row.secret_sha256 : "";
  const actual = secret === undefined ? "" : sha256(String(secret));
  const known = row !== undefined;
  const ok =
    expected.length === actual.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  if (!known || !ok) throw new ApiError(401, "bad_supplier_credentials");
}

function listSuppliers(database) {
  return database.prepare("SELECT ref, label, created_at FROM suppliers ORDER BY ref").all();
}

function registerFacility(database, body) {
  requireBody(body, ["ref", "supplier_ref", "product_category"]);
  getSupplier(database, body.supplier_ref);
  getCategory(database, body.product_category);
  try {
    database
      .prepare(
        `INSERT INTO facilities(ref, supplier_ref, product_category, registration_status, created_at)
         VALUES (?, ?, ?, 'unregistered', ?)`
      )
      .run(body.ref, body.supplier_ref, body.product_category, nowIso());
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throw new ApiError(409, "facility_exists");
    }
    throw error;
  }
  return getFacility(database, body.ref);
}

function getFacility(database, ref) {
  const row = database.prepare("SELECT * FROM facilities WHERE ref = ?").get(ref);
  if (!row) throw new ApiError(404, "facility_not_found");
  return row;
}

// 校验意向/订单上下文中设施确属该供应商且生产该类别
function assertFacilityContext(database, { supplier_ref, facility_ref, product_category }) {
  const facility = getFacility(database, facility_ref);
  if (supplier_ref !== undefined && facility.supplier_ref !== supplier_ref) {
    throw new ApiError(400, "facility_supplier_mismatch", {
      facility_ref,
      supplier_ref: facility.supplier_ref,
    });
  }
  if (product_category !== undefined && facility.product_category !== product_category) {
    throw new ApiError(400, "facility_category_mismatch", {
      facility_ref,
      product_category: facility.product_category,
    });
  }
  return facility;
}

function markFacilityRegistered(database, ref) {
  getFacility(database, ref);
  database
    .prepare(
      `UPDATE facilities
         SET registration_status = 'registered',
             registered_at = COALESCE(registered_at, ?)
       WHERE ref = ?`
    )
    .run(nowIso(), ref);
  return getFacility(database, ref);
}

function listFacilities(database, supplierRef) {
  if (supplierRef) {
    return database
      .prepare("SELECT * FROM facilities WHERE supplier_ref = ? ORDER BY ref")
      .all(supplierRef);
  }
  return database.prepare("SELECT * FROM facilities ORDER BY ref").all();
}

// ---------- 材料版本与来源合并 ----------

function getBundle(database, supplierRef, facilityRef, productCategory) {
  return database
    .prepare(
      `SELECT * FROM document_bundles
        WHERE supplier_ref = ? AND facility_ref = ? AND product_category = ?`
    )
    .get(supplierRef, facilityRef, productCategory);
}

function upsertBundle(database, supplierRef, facilityRef, productCategory) {
  const stamp = nowIso();
  database
    .prepare(
      `INSERT INTO document_bundles(supplier_ref, facility_ref, product_category, current_revision_no, updated_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(supplier_ref, facility_ref, product_category) DO UPDATE SET updated_at = excluded.updated_at`
    )
    .run(supplierRef, facilityRef, productCategory, stamp);
  return getBundle(database, supplierRef, facilityRef, productCategory);
}

function canonicalDigest(documents) {
  const canonical = documents
    .map((doc) => [doc.item_code ?? null, doc.document_ref, doc.document_sha256])
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return sha256(JSON.stringify(canonical));
}

// 递交材料：展会(expo)与企业(enterprise)走同一入口。
// 内容相同的重复递交只合并来源、不产生新版本；内容变化才生成新版本。
function submitDocuments(database, body) {
  requireBody(body, [
    "supplier_ref",
    "facility_ref",
    "product_category",
    "submitted_via",
    "source_ref",
    "documents",
  ]);
  if (!["expo", "enterprise"].includes(body.submitted_via)) {
    throw new ApiError(400, "invalid_submitted_via");
  }
  if (!Array.isArray(body.documents) || body.documents.length === 0) {
    throw new ApiError(400, "documents_required");
  }
  for (const doc of body.documents) {
    if (!doc || typeof doc.document_ref !== "string" || typeof doc.document_sha256 !== "string") {
      throw new ApiError(400, "invalid_document");
    }
    if (!/^[a-f0-9]{64}$/.test(doc.document_sha256)) {
      throw new ApiError(400, "invalid_document_digest", { document_ref: doc.document_ref });
    }
  }
  assertFacilityContext(database, body);

  return transaction(database, () => {
    const bundle = upsertBundle(database, body.supplier_ref, body.facility_ref, body.product_category);
    const digest = canonicalDigest(body.documents);
    const stamp = nowIso();

    let latest = database
      .prepare("SELECT * FROM document_revisions WHERE bundle_id = ? ORDER BY revision_no DESC LIMIT 1")
      .get(bundle.id);
    let changed = false;

    if (!latest || latest.digest_sha256 !== digest) {
      const revisionNo = bundle.current_revision_no + 1;
      const revisionResult = database
        .prepare(
          `INSERT INTO document_revisions(bundle_id, revision_no, digest_sha256, submitted_via, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(bundle.id, revisionNo, digest, body.submitted_via, stamp);
      const revisionId = Number(revisionResult.lastInsertRowid);
      for (const doc of body.documents) {
        const itemResult = database
          .prepare(
            `INSERT INTO document_revision_items(revision_id, item_code, document_ref, document_sha256)
             VALUES (?, ?, ?, ?)`
          )
          .run(revisionId, doc.item_code ?? null, doc.document_ref, doc.document_sha256);
        database
          .prepare(
            `INSERT OR IGNORE INTO document_sources(revision_item_id, source_kind, source_ref, received_at)
             VALUES (?, ?, ?, ?)`
          )
          .run(Number(itemResult.lastInsertRowid), body.submitted_via, body.source_ref, stamp);
      }
      database
        .prepare("UPDATE document_bundles SET current_revision_no = ?, updated_at = ? WHERE id = ?")
        .run(revisionNo, stamp, bundle.id);
      latest = database.prepare("SELECT * FROM document_revisions WHERE id = ?").get(revisionId);
      changed = true;
    } else {
      // 内容完全相同：把本次来源挂到已有版本的每份文件上，各自留痕
      const items = database
        .prepare("SELECT * FROM document_revision_items WHERE revision_id = ?")
        .all(latest.id);
      for (const doc of body.documents) {
        const item = items.find((candidate) => candidate.document_ref === doc.document_ref);
        database
          .prepare(
            `INSERT OR IGNORE INTO document_sources(revision_item_id, source_kind, source_ref, received_at)
             VALUES (?, ?, ?, ?)`
          )
          .run(item.id, body.submitted_via, body.source_ref, stamp);
      }
    }

    // 新版本中包含待补 item_code 文件时，自动核销对应补件请求
    const resolved = [];
    const submittedItemCodes = new Set(
      body.documents.map((doc) => doc.item_code).filter((code) => code !== undefined)
    );
    if (submittedItemCodes.size > 0) {
      const pending = database
        .prepare(
          `SELECT * FROM supplement_requests
            WHERE bundle_id = ? AND status = 'requested' AND item_code IN (${[...submittedItemCodes]
              .map(() => "?")
              .join(",")})`
        )
        .all(bundle.id, ...submittedItemCodes);
      for (const request of pending) {
        database
          .prepare(
            `UPDATE supplement_requests
               SET status = 'submitted', resolved_at = ?, resolved_revision_id = ?
             WHERE id = ?`
          )
          .run(stamp, latest.id, request.id);
        resolved.push({ item_code: request.item_code, application_revision: latest.revision_no });
      }
    }

    return {
      bundle: bundleToJson(getBundle(database, bundle.supplier_ref, bundle.facility_ref, bundle.product_category)),
      application_revision: latest.revision_no,
      content_changed: changed,
      merged_source: { submitted_via: body.submitted_via, source_ref: body.source_ref },
      resolved_supplements: resolved,
    };
  });
}

function requestSupplement(database, body) {
  requireBody(body, ["supplier_ref", "facility_ref", "product_category", "item_code"]);
  assertFacilityContext(database, body);
  const bundle = upsertBundle(database, body.supplier_ref, body.facility_ref, body.product_category);
  const result = database
    .prepare(
      `INSERT INTO supplement_requests(bundle_id, item_code, detail, requested_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(bundle.id, body.item_code, body.detail ?? "", nowIso());
  return database
    .prepare(
      `SELECT sr.id, b.supplier_ref, b.facility_ref, b.product_category, sr.item_code, sr.detail,
              sr.status, sr.requested_at, sr.resolved_at, sr.resolved_revision_id
         FROM supplement_requests sr JOIN document_bundles b ON b.id = sr.bundle_id
        WHERE sr.id = ?`
    )
    .get(Number(result.lastInsertRowid));
}

function bundleToJson(bundle) {
  return {
    supplier_ref: bundle.supplier_ref,
    facility_ref: bundle.facility_ref,
    product_category: bundle.product_category,
    application_revision: bundle.current_revision_no,
    updated_at: bundle.updated_at,
  };
}

function listBundles(database, supplierRef) {
  const rows = supplierRef
    ? database.prepare("SELECT * FROM document_bundles WHERE supplier_ref = ? ORDER BY id").all(supplierRef)
    : database.prepare("SELECT * FROM document_bundles ORDER BY id").all();
  return rows.map(bundleToJson);
}

function listSupplements(database, { supplierRef, status } = {}) {
  const clauses = [];
  const params = [];
  if (supplierRef) {
    clauses.push("b.supplier_ref = ?");
    params.push(supplierRef);
  }
  if (status) {
    clauses.push("sr.status = ?");
    params.push(status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return database
    .prepare(
      `SELECT sr.id, b.supplier_ref, b.facility_ref, b.product_category, sr.item_code, sr.detail,
              sr.status, sr.requested_at, sr.resolved_at, sr.resolved_revision_id,
              rv.revision_no AS resolved_revision_no
         FROM supplement_requests sr
         JOIN document_bundles b ON b.id = sr.bundle_id
         LEFT JOIN document_revisions rv ON rv.id = sr.resolved_revision_id
         ${where}
         ORDER BY sr.id`
    )
    .all(...params);
}

// ---------- 批准（许可）与生效范围 ----------

function scopeItemsOf(database, approvalId) {
  return database
    .prepare("SELECT item_code FROM approval_scope_items WHERE approval_id = ? ORDER BY item_code")
    .all(approvalId)
    .map((row) => row.item_code);
}

function approvalToJson(database, approval) {
  return {
    id: approval.id,
    facility_ref: approval.facility_ref,
    product_category: approval.product_category,
    authority_code: approval.authority_code,
    approval_scope: scopeItemsOf(database, approval.id),
    scope_summary: approval.scope_summary,
    effective_from: approval.effective_from,
    effective_to: approval.effective_to,
    supersedes_id: approval.supersedes_id,
    created_at: approval.created_at,
  };
}

// 许可更新通过新行表达：新旧许可各自带生效时间窗，订舱按计划日期挑选适用许可
function grantApproval(database, body) {
  requireBody(body, ["facility_ref", "product_category", "authority_code", "scope_items", "effective_from"]);
  const facility = getFacility(database, body.facility_ref);
  if (facility.product_category !== body.product_category) {
    throw new ApiError(400, "facility_category_mismatch", { product_category: facility.product_category });
  }
  const authority = database
    .prepare("SELECT code FROM competent_authorities WHERE code = ?")
    .get(body.authority_code);
  if (!authority) throw new ApiError(404, "authority_not_found");
  if (!Array.isArray(body.scope_items) || body.scope_items.length === 0) {
    throw new ApiError(400, "approval_scope_required");
  }
  const effectiveFrom = parseIso(body.effective_from, "effective_from");
  const effectiveTo = body.effective_to === undefined || body.effective_to === null
    ? null
    : parseIso(body.effective_to, "effective_to");
  if (effectiveTo && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) {
    throw new ApiError(400, "invalid_approval_window");
  }
  if (body.supersedes_id !== undefined) {
    const prior = database.prepare("SELECT id FROM approvals WHERE id = ?").get(body.supersedes_id);
    if (!prior) throw new ApiError(404, "superseded_approval_not_found");
  }

  return transaction(database, () => {
    const result = database
      .prepare(
        `INSERT INTO approvals(facility_ref, product_category, authority_code, scope_summary,
                               effective_from, effective_to, supersedes_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        body.facility_ref,
        body.product_category,
        body.authority_code,
        body.scope_summary ?? "",
        effectiveFrom,
        effectiveTo,
        body.supersedes_id ?? null,
        nowIso()
      );
    const approvalId = Number(result.lastInsertRowid);
    for (const itemCode of body.scope_items) {
      database
        .prepare("INSERT INTO approval_scope_items(approval_id, item_code) VALUES (?, ?)")
        .run(approvalId, itemCode);
    }
    // 许可更新：旧许可在新生效日关闭；已订舱/已通关批次通过快照保留其适用许可
    if (body.supersedes_id !== undefined && body.supersedes_id !== null) {
      database
        .prepare(
          `UPDATE approvals
              SET effective_to = ?
            WHERE id = ? AND (effective_to IS NULL OR effective_to > ?)`
        )
        .run(effectiveFrom, body.supersedes_id, effectiveFrom);
    }
    return approvalToJson(database, database.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId));
  });
}

function listApprovals(database, facilityRef) {
  const rows = facilityRef
    ? database
        .prepare("SELECT * FROM approvals WHERE facility_ref = ? ORDER BY effective_from DESC, id DESC")
        .all(facilityRef)
    : database.prepare("SELECT * FROM approvals ORDER BY effective_from DESC, id DESC").all();
  return rows.map((row) => approvalToJson(database, row));
}

// 在指定时刻，对该设施/类别/具体货物生效且覆盖该范围项的批准
function findEffectiveApproval(database, { facility_ref, product_category, scope_item, at }) {
  const instant = new Date(at).toISOString();
  return database
    .prepare(
      `SELECT a.* FROM approvals a
         JOIN approval_scope_items s ON s.approval_id = a.id
        WHERE a.facility_ref = ?
          AND a.product_category = ?
          AND s.item_code = ?
          AND a.effective_from <= ?
          AND (a.effective_to IS NULL OR a.effective_to > ?)
        ORDER BY a.effective_from DESC, a.id DESC
        LIMIT 1`
    )
    .get(facility_ref, product_category, scope_item, instant, instant);
}

function pendingSupplements(database, facilityRef, productCategory) {
  return database
    .prepare(
      `SELECT sr.item_code, sr.detail, sr.requested_at
         FROM supplement_requests sr
         JOIN document_bundles b ON b.id = sr.bundle_id
        WHERE b.facility_ref = ? AND b.product_category = ? AND sr.status = 'requested'
        ORDER BY sr.id`
    )
    .all(facilityRef, productCategory);
}

// 准入闸门：明确回答“补材料 / 等批准 / 安排首批货”
// ready 之外的任何状态都不允许生成可履约订单或通关批次。
function evaluateGate(database, { facility_ref, product_category, scope_item, at = nowIso() }) {
  const facility = getFacility(database, facility_ref);
  if (facility.registration_status !== "registered") {
    return { status: "facility_unregistered", next_action: "await_facility_registration", at };
  }
  const approval = findEffectiveApproval(database, {
    facility_ref,
    product_category,
    scope_item,
    at,
  });
  if (!approval) {
    const pending = pendingSupplements(database, facility_ref, product_category);
    const bundle = getBundle(database, facility.supplier_ref, facility_ref, product_category);
    let nextAction = "await_approval";
    if (pending.length > 0) nextAction = "supplement_documents";
    else if (!bundle || bundle.current_revision_no === 0) nextAction = "submit_documents";
    return {
      status: "approval_not_in_force",
      next_action: nextAction,
      pending_supplements: pending,
      at,
    };
  }
  return {
    status: "ready",
    next_action: "arrange_first_shipment",
    approval: approvalToJson(database, approval),
    at,
  };
}

// ---------- 采购意向、买方确认与退出 ----------

function intentionToJson(database, row, options = {}) {
  const json = {
    ref: row.ref,
    supplier_ref: row.supplier_ref,
    facility_ref: row.facility_ref,
    product_category: row.product_category,
    approval_scope: [row.scope_item],
    scope_item: row.scope_item,
    buyer_ref: row.buyer_ref,
    quantity_kg: row.quantity_kg,
    status: row.status,
    created_at: row.created_at,
    confirmed_at: row.confirmed_at,
    withdrawn_at: row.withdrawn_at,
  };
  const order = database
    .prepare("SELECT ref FROM fulfilled_orders WHERE intention_id = ?")
    .get(row.id);
  if (order) json.order_ref = order.ref;
  if (options.includeGate) {
    json.gate = evaluateGate(database, {
      facility_ref: row.facility_ref,
      product_category: row.product_category,
      scope_item: row.scope_item,
      at: options.at ?? nowIso(),
    });
  }
  return json;
}

function createIntention(database, body) {
  requireBody(body, ["supplier_ref", "facility_ref", "product_category", "scope_item", "buyer_ref", "quantity_kg"]);
  assertFacilityContext(database, body);
  const quantity = Number(body.quantity_kg);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new ApiError(400, "invalid_quantity");
  }
  const ref = body.ref ?? randomRef("INT");
  try {
    database
      .prepare(
        `INSERT INTO purchase_intentions(ref, supplier_ref, facility_ref, product_category,
                                         scope_item, buyer_ref, quantity_kg, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ref,
        body.supplier_ref,
        body.facility_ref,
        body.product_category,
        body.scope_item,
        body.buyer_ref,
        quantity,
        nowIso()
      );
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw new ApiError(409, "intention_exists");
    throw error;
  }
  return intentionToJson(database, getIntentionRow(database, ref));
}

function getIntentionRow(database, ref) {
  const row = database.prepare("SELECT * FROM purchase_intentions WHERE ref = ?").get(ref);
  if (!row) throw new ApiError(404, "intention_not_found");
  return row;
}

function getIntention(database, ref, options = {}) {
  return intentionToJson(database, getIntentionRow(database, ref), options);
}

function listIntentions(database, { supplierRef, buyerRef, status, includeGate } = {}) {
  const clauses = [];
  const params = [];
  if (supplierRef) {
    clauses.push("supplier_ref = ?");
    params.push(supplierRef);
  }
  if (buyerRef) {
    clauses.push("buyer_ref = ?");
    params.push(buyerRef);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return database
    .prepare(`SELECT * FROM purchase_intentions ${where} ORDER BY id`)
    .all(...params)
    .map((row) => intentionToJson(database, row, { includeGate }));
}

// 买方确认：确认后的需求不再能被退出释放
function confirmIntention(database, ref) {
  return transaction(database, () => {
    const row = getIntentionRow(database, ref);
    if (row.status === "confirmed") return intentionToJson(database, row);
    if (row.status === "withdrawn") {
      throw new ApiError(409, "intention_withdrawn");
    }
    database
      .prepare("UPDATE purchase_intentions SET status = 'confirmed', confirmed_at = ? WHERE id = ?")
      .run(nowIso(), row.id);
    return intentionToJson(database, getIntentionRow(database, ref));
  });
}

// 买方退出：仅释放尚未确认的需求
function withdrawIntention(database, ref) {
  return transaction(database, () => {
    const row = getIntentionRow(database, ref);
    if (row.status === "withdrawn") throw new ApiError(409, "intention_already_withdrawn");
    if (row.status === "confirmed") {
      throw new ApiError(403, "buyer_commitment_locked");
    }
    database
      .prepare("UPDATE purchase_intentions SET status = 'withdrawn', withdrawn_at = ? WHERE id = ?")
      .run(nowIso(), row.id);
    return intentionToJson(database, getIntentionRow(database, ref));
  });
}

// ---------- 商机转可履约订单：硬闸门 ----------

function orderToJson(database, order) {
  return {
    ref: order.ref,
    intention_ref: database.prepare("SELECT ref FROM purchase_intentions WHERE id = ?").get(order.intention_id).ref,
    supplier_ref: order.supplier_ref,
    facility_ref: order.facility_ref,
    product_category: order.product_category,
    approval_scope: [order.scope_item],
    scope_item: order.scope_item,
    buyer_ref: order.buyer_ref,
    quantity_kg: order.quantity_kg,
    approval_id: order.approval_id,
    created_at: order.created_at,
  };
}

function fulfillIntention(database, ref, options = {}) {
  return transaction(database, () => {
    const row = getIntentionRow(database, ref);
    const existing = database
      .prepare("SELECT * FROM fulfilled_orders WHERE intention_id = ?")
      .get(row.id);
    if (existing) return orderToJson(database, existing); // 幂等

    if (row.status === "withdrawn") throw new ApiError(409, "intention_withdrawn");
    if (row.status !== "confirmed") throw new ApiError(409, "intention_not_confirmed");

    const gate = evaluateGate(database, {
      facility_ref: row.facility_ref,
      product_category: row.product_category,
      scope_item: row.scope_item,
      at: options.at ?? nowIso(),
    });
    if (gate.status === "facility_unregistered") {
      throw new ApiError(403, "facility_not_registered", { gate });
    }
    if (gate.status === "approval_not_in_force") {
      throw new ApiError(403, "approval_not_in_force", { gate });
    }

    const result = database
      .prepare(
        `INSERT INTO fulfilled_orders(ref, intention_id, supplier_ref, facility_ref, product_category,
                                     scope_item, buyer_ref, quantity_kg, approval_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomRef("ORD"),
        row.id,
        row.supplier_ref,
        row.facility_ref,
        row.product_category,
        row.scope_item,
        row.buyer_ref,
        row.quantity_kg,
        gate.approval.id,
        nowIso()
      );
    return orderToJson(
      database,
      database.prepare("SELECT * FROM fulfilled_orders WHERE id = ?").get(Number(result.lastInsertRowid))
    );
  });
}

function getOrderRowByRef(database, ref) {
  const row = database.prepare("SELECT * FROM fulfilled_orders WHERE ref = ?").get(ref);
  if (!row) throw new ApiError(404, "order_not_found");
  return row;
}

function listOrders(database, { supplierRef, buyerRef } = {}) {
  const clauses = [];
  const params = [];
  if (supplierRef) {
    clauses.push("supplier_ref = ?");
    params.push(supplierRef);
  }
  if (buyerRef) {
    clauses.push("buyer_ref = ?");
    params.push(buyerRef);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return database
    .prepare(`SELECT * FROM fulfilled_orders ${where} ORDER BY id`)
    .all(...params)
    .map((row) => orderToJson(database, row));
}

// ---------- 通关批次：订舱再次过闸，固化批准快照 ----------

function shipmentToJson(database, shipment) {
  const order = database.prepare("SELECT ref AS order_ref FROM fulfilled_orders WHERE id = ?").get(shipment.order_id);
  return {
    shipment_ref: shipment.shipment_ref,
    order_ref: order.order_ref,
    approval_id: shipment.approval_id,
    planned_at: shipment.planned_at,
    status: shipment.status,
    created_at: shipment.created_at,
    cleared_at: shipment.cleared_at,
  };
}

function bookShipment(database, body) {
  requireBody(body, ["order_ref", "planned_at"]);
  const plannedAt = parseIso(body.planned_at, "planned_at");
  return transaction(database, () => {
    const order = getOrderRowByRef(database, body.order_ref);
    const gate = evaluateGate(database, {
      facility_ref: order.facility_ref,
      product_category: order.product_category,
      scope_item: order.scope_item,
      at: plannedAt,
    });
    if (gate.status !== "ready") {
      // 许可更新只影响适用的新批次：计划日期不在任何批准窗内即拒绝订舱
      throw new ApiError(403, "shipment_outside_approval", { gate });
    }
    const shipmentRef = body.shipment_ref ?? randomRef("SHP");
    try {
      const result = database
        .prepare(
          `INSERT INTO customs_shipments(shipment_ref, order_id, approval_id, planned_at, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(shipmentRef, order.id, gate.approval.id, new Date(plannedAt).toISOString(), nowIso());
      return shipmentToJson(
        database,
        database.prepare("SELECT * FROM customs_shipments WHERE id = ?").get(Number(result.lastInsertRowid))
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        const existing = database
          .prepare("SELECT * FROM customs_shipments WHERE shipment_ref = ?")
          .get(shipmentRef);
        return shipmentToJson(database, existing); // 幂等
      }
      throw error;
    }
  });
}

function getShipmentRow(database, shipmentRef) {
  const row = database.prepare("SELECT * FROM customs_shipments WHERE shipment_ref = ?").get(shipmentRef);
  if (!row) throw new ApiError(404, "shipment_not_found");
  return row;
}

function clearShipment(database, shipmentRef) {
  return transaction(database, () => {
    const row = getShipmentRow(database, shipmentRef);
    if (row.status !== "cleared") {
      database
        .prepare("UPDATE customs_shipments SET status = 'cleared', cleared_at = ? WHERE id = ?")
        .run(nowIso(), row.id);
    }
    return shipmentToJson(database, getShipmentRow(database, shipmentRef));
  });
}

function listShipments(database, { supplierRef, buyerRef, status } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push("s.status = ?");
    params.push(status);
  }
  if (supplierRef) {
    clauses.push("o.supplier_ref = ?");
    params.push(supplierRef);
  }
  if (buyerRef) {
    clauses.push("o.buyer_ref = ?");
    params.push(buyerRef);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return database
    .prepare(
      `SELECT s.* FROM customs_shipments s
         JOIN fulfilled_orders o ON o.id = s.order_id
         ${where}
        ORDER BY s.id`
    )
    .all(...params)
    .map((row) => shipmentToJson(database, row));
}

// ---------- 供应商门户：我的补件、有效许可、买方确认 ----------

function supplierPortal(database, supplierRef) {
  getSupplier(database, supplierRef);
  const at = nowIso();

  const supplements = listSupplements(database, { supplierRef: supplierRef });
  const validApprovals = database
    .prepare(
      `SELECT a.* FROM approvals a
         JOIN facilities f ON f.ref = a.facility_ref
        WHERE f.supplier_ref = ?
          AND a.effective_from <= ?
          AND (a.effective_to IS NULL OR a.effective_to > ?)
        ORDER BY a.facility_ref, a.product_category, a.effective_from DESC, a.id DESC`
    )
    .all(supplierRef, at, at)
    .map((approval) => approvalToJson(database, approval));

  const buyerConfirmations = database
    .prepare(
      `SELECT i.*, o.ref AS order_ref
         FROM purchase_intentions i
         LEFT JOIN fulfilled_orders o ON o.intention_id = i.id
        WHERE i.supplier_ref = ? AND i.status = 'confirmed'
        ORDER BY i.confirmed_at, i.id`
    )
    .all(supplierRef)
    .map((row) => ({
      intention_ref: row.ref,
      buyer_ref: row.buyer_ref,
      facility_ref: row.facility_ref,
      product_category: row.product_category,
      approval_scope: [row.scope_item],
      quantity_kg: row.quantity_kg,
      confirmed_at: row.confirmed_at,
      order_ref: row.order_ref ?? null,
    }));

  return {
    supplier_ref: supplierRef,
    at,
    pending_supplements: supplements.filter((item) => item.status === "requested"),
    resolved_supplements: supplements.filter((item) => item.status !== "requested"),
    valid_approvals: validApprovals,
    buyer_confirmations: buyerConfirmations,
  };
}

// ---------- 平台统计：洽谈 / 获准企业 / 实际通关 / 复购 严格区分 ----------

function platformStats(database) {
  const at = nowIso();
  const scalar = (sql, ...params) => database.prepare(sql).get(...params).count;

  const talks = scalar("SELECT COUNT(*) AS count FROM purchase_intentions");
  const openTalks = scalar("SELECT COUNT(*) AS count FROM purchase_intentions WHERE status = 'open'");
  const confirmedTalks = scalar("SELECT COUNT(*) AS count FROM purchase_intentions WHERE status = 'confirmed'");
  const withdrawnTalks = scalar("SELECT COUNT(*) AS count FROM purchase_intentions WHERE status = 'withdrawn'");

  const approvedSuppliers = scalar(
    `SELECT COUNT(DISTINCT f.supplier_ref) AS count
       FROM approvals a JOIN facilities f ON f.ref = a.facility_ref
      WHERE a.effective_from <= ? AND (a.effective_to IS NULL OR a.effective_to > ?)`,
    at,
    at
  );
  const approvedFacilities = scalar(
    `SELECT COUNT(DISTINCT a.facility_ref) AS count
       FROM approvals a JOIN facilities f ON f.ref = a.facility_ref
      WHERE f.registration_status = 'registered'
        AND a.effective_from <= ? AND (a.effective_to IS NULL OR a.effective_to > ?)`,
    at,
    at
  );
  const fulfilledOrders = scalar("SELECT COUNT(*) AS count FROM fulfilled_orders");
  const clearedShipments = scalar(
    "SELECT COUNT(*) AS count FROM customs_shipments WHERE status = 'cleared'"
  );
  const clearedSuppliers = scalar(
    `SELECT COUNT(DISTINCT o.supplier_ref) AS count
       FROM customs_shipments s JOIN fulfilled_orders o ON o.id = s.order_id
      WHERE s.status = 'cleared'`
  );

  // 复购：同一买方实际通关达到 2 批及以上；repeat_shipments 为各买方第 2 批起的批次数
  const perBuyer = database
    .prepare(
      `SELECT o.buyer_ref AS buyer_ref, COUNT(*) AS count
         FROM customs_shipments s JOIN fulfilled_orders o ON o.id = s.order_id
        WHERE s.status = 'cleared'
        GROUP BY o.buyer_ref`
    )
    .all();
  const repeatBuyers = perBuyer.filter((row) => row.count >= 2).length;
  const repeatShipments = perBuyer.reduce(
    (sum, row) => sum + (row.count >= 2 ? row.count - 1 : 0),
    0
  );

  return {
    at,
    talks: {
      total: talks,
      open: openTalks,
      confirmed: confirmedTalks,
      withdrawn: withdrawnTalks,
    },

    approved: {
      suppliers: approvedSuppliers,
      facilities: approvedFacilities,
    },
    fulfilled_orders: fulfilledOrders,
    customs: {
      cleared_shipments: clearedShipments,
      cleared_suppliers: clearedSuppliers,
    },
    repeat: {
      repeat_buyers: repeatBuyers,
      repeat_shipments: repeatShipments,
    },
  };
}

module.exports = {
  ApiError,
  nowIso,
  sha256,
  createCategory,
  listCategories,
  createAuthority,
  listAuthorities,
  registerSupplier,
  authenticateSupplier,
  listSuppliers,
  registerFacility,
  markFacilityRegistered,
  listFacilities,
  submitDocuments,
  requestSupplement,
  listBundles,
  listSupplements,
  grantApproval,
  listApprovals,
  findEffectiveApproval,
  evaluateGate,
  createIntention,
  getIntention,
  listIntentions,
  confirmIntention,
  withdrawIntention,
  fulfillIntention,
  listOrders,
  bookShipment,
  clearShipment,
  listShipments,
  supplierPortal,
  platformStats,
};
