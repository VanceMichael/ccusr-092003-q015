"use strict";

const crypto = require("node:crypto");

// 供应商准入接续领域服务。
// 不变量：
//   1. 设施未在主管机关完成注册，采购意向不得转为订单；
//   2. 货物 hs 编码/形态不在有效批准范围内，采购意向不得转为订单；
//   3. 重复材料按内容摘要合并，只新增来源、不复制内容；
//   4. 许可更新产生新版本；批次在申报时冻结当时版本，旧版本不影响已申报批次；
//   5. 买方只能撤回仍在洽谈（未确认）的意向；
//   6. 平台统计严格区分洽谈、获准企业、实际通关与复购四个口径。

class DomainError extends Error {
  constructor(code, message, { status = 409, details } = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function parseScope(scopeText) {
  try {
    const scope = JSON.parse(scopeText);
    if (!Array.isArray(scope.hs_codes) || !Array.isArray(scope.forms)) {
      throw new Error("bad scope");
    }
    return scope;
  } catch {
    throw new DomainError("VALIDATION_ERROR", "批准范围必须包含 hs_codes 与 forms 数组", {
      status: 400,
    });
  }
}

// 税目按层级匹配：批准范围可写 4/6 位上位税目（如 0811 覆盖 08119000）。
function hsCodeCovered(allowedCodes, code) {
  return allowedCodes.some(
    (allowed) => allowed === code || (allowed.length >= 4 && code.startsWith(allowed)),
  );
}

function scopeCovers(scopeText, hsCode, form) {
  const scope = parseScope(scopeText);
  return hsCodeCovered(scope.hs_codes, hsCode) && scope.forms.includes(form);
}

function createDomain(db) {
  db.exec("PRAGMA foreign_keys = ON");

  function withTransaction(action) {
    db.exec("BEGIN");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function required(value, field) {
    if (value === undefined || value === null || value === "") {
      throw new DomainError("VALIDATION_ERROR", `缺少必填字段：${field}`, { status: 400 });
    }
    return value;
  }

  // ---------- 基础资料 ----------

  function upsertCategory({ category_code, name, hs_codes = [] }) {
    required(category_code, "category_code");
    required(name, "name");
    db.prepare(
      `INSERT INTO product_categories(category_code, name, hs_codes, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(category_code) DO UPDATE SET name = excluded.name, hs_codes = excluded.hs_codes`,
    ).run(category_code, name, JSON.stringify(hs_codes), nowIso());
    return getCategory(category_code);
  }

  function getCategory(category_code) {
    const row = db.prepare("SELECT * FROM product_categories WHERE category_code = ?").get(category_code);
    if (!row) {
      throw new DomainError("NOT_FOUND", `产品类别不存在：${category_code}`, { status: 404 });
    }
    return { ...row, hs_codes: JSON.parse(row.hs_codes) };
  }

  function listCategories() {
    return db
      .prepare("SELECT * FROM product_categories ORDER BY category_code")
      .all()
      .map((row) => ({ ...row, hs_codes: JSON.parse(row.hs_codes) }));
  }

  function upsertAuthority({ authority_ref, name, country_code }) {
    required(authority_ref, "authority_ref");
    required(name, "name");
    required(country_code, "country_code");
    db.prepare(
      `INSERT INTO competent_authorities(authority_ref, name, country_code, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(authority_ref) DO UPDATE SET name = excluded.name, country_code = excluded.country_code`,
    ).run(authority_ref, name, country_code, nowIso());
    return db.prepare("SELECT * FROM competent_authorities WHERE authority_ref = ?").get(authority_ref);
  }

  function registerSupplier({ supplier_ref, display_name, country_code, access_token }) {
    required(supplier_ref, "supplier_ref");
    required(display_name, "display_name");
    required(country_code, "country_code");
    const token = access_token || crypto.randomUUID();
    db.prepare(
      `INSERT INTO suppliers(supplier_ref, display_name, country_code, access_token, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(supplier_ref) DO UPDATE SET
         display_name = excluded.display_name, country_code = excluded.country_code`,
    ).run(supplier_ref, display_name, country_code, token, nowIso());
    return db.prepare("SELECT supplier_ref, display_name, country_code, created_at FROM suppliers WHERE supplier_ref = ?").get(supplier_ref);
  }

  function getSupplierByToken(token) {
    if (!token) {
      throw new DomainError("UNAUTHORIZED", "缺少供应商访问令牌", { status: 401 });
    }
    const row = db
      .prepare("SELECT supplier_ref, display_name, country_code FROM suppliers WHERE access_token = ?")
      .get(token);
    if (!row) {
      throw new DomainError("UNAUTHORIZED", "访问令牌无效", { status: 401 });
    }
    return row;
  }

  function getSupplier(supplierRef) {
    const row = db
      .prepare("SELECT supplier_ref, display_name, country_code, created_at FROM suppliers WHERE supplier_ref = ?")
      .get(supplierRef);
    if (!row) {
      throw new DomainError("NOT_FOUND", `供应商不存在：${supplierRef}`, { status: 404 });
    }
    return row;
  }

  function upsertFacility({ facility_ref, supplier_ref, name, country_code }) {
    required(facility_ref, "facility_ref");
    required(supplier_ref, "supplier_ref");
    required(name, "name");
    required(country_code, "country_code");
    getSupplier(supplier_ref);
    db.prepare(
      `INSERT INTO facilities(facility_ref, supplier_ref, name, country_code, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(facility_ref) DO UPDATE SET name = excluded.name, country_code = excluded.country_code`,
    ).run(facility_ref, supplier_ref, name, country_code, nowIso());
    return getFacility(facility_ref);
  }

  function getFacility(facilityRef) {
    const row = db.prepare("SELECT * FROM facilities WHERE facility_ref = ?").get(facilityRef);
    if (!row) {
      throw new DomainError("NOT_FOUND", `生产设施不存在：${facilityRef}`, { status: 404 });
    }
    return row;
  }

  function getFacilityOfSupplier(facilityRef, supplierRef) {
    const facility = getFacility(facilityRef);
    if (facility.supplier_ref !== supplierRef) {
      throw new DomainError("VALIDATION_ERROR", "设施不属于该供应商", { status: 400 });
    }
    return facility;
  }

  // ---------- 设施注册 ----------

  function submitRegistration({ facility_ref, authority_ref }) {
    required(facility_ref, "facility_ref");
    required(authority_ref, "authority_ref");
    getFacility(facility_ref);
    if (!db.prepare("SELECT 1 FROM competent_authorities WHERE authority_ref = ?").get(authority_ref)) {
      throw new DomainError("NOT_FOUND", `主管机关不存在：${authority_ref}`, { status: 404 });
    }
    return withTransaction(() => {
      const existing = db
        .prepare("SELECT * FROM facility_registrations WHERE facility_ref = ? AND authority_ref = ?")
        .get(facility_ref, authority_ref);
      if (existing) return existing;
      const registration_id = newId("reg");
      db.prepare(
        `INSERT INTO facility_registrations(registration_id, facility_ref, authority_ref, status, updated_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      ).run(registration_id, facility_ref, authority_ref, nowIso());
      return db
        .prepare("SELECT * FROM facility_registrations WHERE registration_id = ?")
        .get(registration_id);
    });
  }

  function setRegistrationStatus(facilityRef, authorityRef, status) {
    const row = db
      .prepare("SELECT * FROM facility_registrations WHERE facility_ref = ? AND authority_ref = ?")
      .get(facilityRef, authorityRef);
    if (!row) {
      throw new DomainError("NOT_FOUND", "该设施尚未向此主管机关递交注册", { status: 404 });
    }
    const registeredAt = status === "registered" && !row.registered_at ? nowIso() : row.registered_at;
    db.prepare(
      `UPDATE facility_registrations SET status = ?, registered_at = ?, updated_at = ?
       WHERE registration_id = ?`,
    ).run(status, registeredAt, nowIso(), row.registration_id);
    return db.prepare("SELECT * FROM facility_registrations WHERE registration_id = ?").get(row.registration_id);
  }

  function markRegistered({ facility_ref, authority_ref }) {
    return withTransaction(() => {
      getFacility(facility_ref);
      if (!db.prepare("SELECT 1 FROM competent_authorities WHERE authority_ref = ?").get(authority_ref)) {
        throw new DomainError("NOT_FOUND", `主管机关不存在：${authority_ref}`, { status: 404 });
      }
      // 允许直接登记：缺注册记录时补一条 pending 再置为 registered。
      let row = db
        .prepare("SELECT * FROM facility_registrations WHERE facility_ref = ? AND authority_ref = ?")
        .get(facility_ref, authority_ref);
      if (!row) {
        const registration_id = newId("reg");
        db.prepare(
          `INSERT INTO facility_registrations(registration_id, facility_ref, authority_ref, status, updated_at)
           VALUES (?, ?, ?, 'pending', ?)`,
        ).run(registration_id, facility_ref, authority_ref, nowIso());
        row = db.prepare("SELECT * FROM facility_registrations WHERE registration_id = ?").get(registration_id);
      }
      const registeredAt = row.registered_at || nowIso();
      db.prepare(
        "UPDATE facility_registrations SET status = 'registered', registered_at = ?, updated_at = ? WHERE registration_id = ?",
      ).run(registeredAt, nowIso(), row.registration_id);
      return db.prepare("SELECT * FROM facility_registrations WHERE registration_id = ?").get(row.registration_id);
    });
  }

  function listRegistrations(supplierRef) {
    return db
      .prepare(
        `SELECT r.*, f.supplier_ref
           FROM facility_registrations r JOIN facilities f ON f.facility_ref = r.facility_ref
          WHERE f.supplier_ref = ?
          ORDER BY r.facility_ref, r.authority_ref`,
      )
      .all(supplierRef);
  }

  function hasActiveRegistration(facilityRef) {
    return Boolean(
      db
        .prepare("SELECT 1 FROM facility_registrations WHERE facility_ref = ? AND status = 'registered' LIMIT 1")
        .get(facilityRef),
    );
  }

  // ---------- 材料递交与来源合并 ----------

  function submitMaterial(input) {
    const supplier_ref = required(input.supplier_ref, "supplier_ref");
    const facility_ref = required(input.facility_ref, "facility_ref");
    const product_category = required(input.product_category, "product_category");
    const doc_type = required(input.doc_type, "doc_type");
    const content_hash = required(input.content_hash, "content_hash");
    const source = input.source || {};
    const source_channel = source.channel || "enterprise";
    if (!["expo", "enterprise"].includes(source_channel)) {
      throw new DomainError("VALIDATION_ERROR", "来源渠道只能是 expo 或 enterprise", { status: 400 });
    }
    const source_ref = source.source_ref || "";
    getFacilityOfSupplier(facility_ref, supplier_ref);
    getCategory(product_category);

    return withTransaction(() => {
      const existing = db
        .prepare(
          `SELECT * FROM materials
            WHERE supplier_ref = ? AND facility_ref = ? AND product_category = ?
              AND doc_type = ? AND content_hash = ?`,
        )
        .get(supplier_ref, facility_ref, product_category, doc_type, content_hash);

      if (existing) {
        // 同一份材料重复递交：只合并来源，绝不复制内容或抬高版本。
        db.prepare(
          `INSERT OR IGNORE INTO material_sources(material_id, source_channel, source_ref, received_at)
           VALUES (?, ?, ?, ?)`,
        ).run(existing.material_id, source_channel, source_ref, nowIso());
        const sources = listSources(existing.material_id);
        return { merged: true, material: hydrateMaterial({ ...existing, sources }) };
      }

      const latest = db
        .prepare(
          `SELECT MAX(revision) AS revision FROM materials
            WHERE supplier_ref = ? AND facility_ref = ? AND product_category = ? AND doc_type = ?`,
        )
        .get(supplier_ref, facility_ref, product_category, doc_type);
      const revision = Number.isInteger(input.revision)
        ? input.revision
        : (latest.revision || 0) + 1;
      const material_id = newId("mat");
      const ts = nowIso();
      db.prepare(
        `INSERT INTO materials(material_id, supplier_ref, facility_ref, product_category,
                               doc_type, content_hash, revision, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`,
      ).run(material_id, supplier_ref, facility_ref, product_category, doc_type, content_hash, revision, ts, ts);
      db.prepare(
        `INSERT INTO material_sources(material_id, source_channel, source_ref, received_at)
         VALUES (?, ?, ?, ?)`,
      ).run(material_id, source_channel, source_ref, ts);
      // 新版材料递交后，该文件项下的补件请求自动办结。
      db.prepare(
        `UPDATE supplement_requests SET status = 'resolved', resolved_at = ?
          WHERE material_id IN (
            SELECT material_id FROM materials
             WHERE supplier_ref = ? AND facility_ref = ? AND product_category = ? AND doc_type = ?
          ) AND status = 'open'`,
      ).run(ts, supplier_ref, facility_ref, product_category, doc_type);
      const material = db.prepare("SELECT * FROM materials WHERE material_id = ?").get(material_id);
      return { merged: false, material: hydrateMaterial({ ...material, sources: listSources(material_id) }) };
    });
  }

  function listSources(materialId) {
    return db
      .prepare("SELECT source_channel, source_ref, received_at FROM material_sources WHERE material_id = ? ORDER BY received_at")
      .all(materialId);
  }

  function hydrateMaterial(row) {
    return { ...row, sources: row.sources || listSources(row.material_id) };
  }

  function listMaterials(supplierRef, { facility_ref, product_category, doc_type } = {}) {
    const conditions = ["m.supplier_ref = ?"];
    const params = [supplierRef];
    if (facility_ref) {
      conditions.push("m.facility_ref = ?");
      params.push(facility_ref);
    }
    if (product_category) {
      conditions.push("m.product_category = ?");
      params.push(product_category);
    }
    if (doc_type) {
      conditions.push("m.doc_type = ?");
      params.push(doc_type);
    }
    return db
      .prepare(
        `SELECT m.* FROM materials m WHERE ${conditions.join(" AND ")} ORDER BY m.created_at DESC`,
      )
      .all(...params)
      .map((row) => hydrateMaterial(row));
  }

  // ---------- 补件请求 ----------

  function requestSupplement({ material_id, detail }) {
    required(material_id, "material_id");
    required(detail, "detail");
    if (!db.prepare("SELECT 1 FROM materials WHERE material_id = ?").get(material_id)) {
      throw new DomainError("NOT_FOUND", `材料不存在：${material_id}`, { status: 404 });
    }
    const request_id = newId("req");
    db.prepare(
      `INSERT INTO supplement_requests(request_id, material_id, detail, status, created_at)
       VALUES (?, ?, ?, 'open', ?)`,
    ).run(request_id, material_id, detail, nowIso());
    return db.prepare("SELECT * FROM supplement_requests WHERE request_id = ?").get(request_id);
  }

  function resolveSupplement(request_id) {
    const row = db.prepare("SELECT * FROM supplement_requests WHERE request_id = ?").get(request_id);
    if (!row) {
      throw new DomainError("NOT_FOUND", `补件请求不存在：${request_id}`, { status: 404 });
    }
    db.prepare("UPDATE supplement_requests SET status = 'resolved', resolved_at = ? WHERE request_id = ?").run(
      nowIso(),
      request_id,
    );
    return db.prepare("SELECT * FROM supplement_requests WHERE request_id = ?").get(request_id);
  }

  function listSupplementRequests(supplierRef) {
    return db
      .prepare(
        `SELECT r.*, m.supplier_ref, m.facility_ref, m.product_category, m.doc_type, m.revision
           FROM supplement_requests r JOIN materials m ON m.material_id = r.material_id
          WHERE m.supplier_ref = ?
          ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC`,
      )
      .all(supplierRef);
  }

  // ---------- 批准与版本 ----------

  function grantApproval(input) {
    const facility_ref = required(input.facility_ref, "facility_ref");
    const product_category = required(input.product_category, "product_category");
    const authority_ref = required(input.authority_ref, "authority_ref");
    const scope = required(input.scope, "scope");
    if (!Array.isArray(scope.hs_codes) || !Array.isArray(scope.forms) || scope.hs_codes.length === 0) {
      throw new DomainError("VALIDATION_ERROR", "批准范围必须包含至少一个 hs 编码及 forms 数组", {
        status: 400,
      });
    }
    const facility = getFacility(facility_ref);
    getCategory(product_category);
    const registered = db
      .prepare(
        `SELECT 1 FROM facility_registrations
          WHERE facility_ref = ? AND authority_ref = ? AND status = 'registered'`,
      )
      .get(facility_ref, authority_ref);
    if (!registered) {
      throw new DomainError(
        "FACILITY_NOT_REGISTERED",
        "设施尚未在该主管机关完成注册，不得授予准入批准",
        { status: 409, details: { facility_ref, authority_ref } },
      );
    }
    const effective_from = input.effective_from || nowIso();
    const effective_until = input.effective_until || null;

    return withTransaction(() => {
      const current = db
        .prepare(
          `SELECT * FROM approvals
            WHERE facility_ref = ? AND product_category = ? AND status = 'active'`,
        )
        .get(facility_ref, product_category);
      const version = current ? current.version + 1 : 1;
      if (current) {
        db.prepare("UPDATE approvals SET status = 'superseded' WHERE approval_id = ?").run(current.approval_id);
      }
      const approval_id = newId("appr");
      db.prepare(
        `INSERT INTO approvals(approval_id, facility_ref, product_category, authority_ref, scope,
                               version, effective_from, effective_until, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(
        approval_id,
        facility_ref,
        product_category,
        authority_ref,
        JSON.stringify(scope),
        version,
        effective_from,
        effective_until,
        nowIso(),
      );
      return getApproval(approval_id);
    });
  }

  function getApproval(approvalId) {
    const row = db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId);
    if (!row) {
      throw new DomainError("NOT_FOUND", `批准不存在：${approvalId}`, { status: 404 });
    }
    return { ...row, scope: parseScope(row.scope) };
  }

  // 在指定时刻覆盖指定货物的有效批准；许可更新后自动解析到新版本。
  function findEffectiveApproval(facilityRef, productCategory, hsCode, form, at = nowIso()) {
    const rows = db
      .prepare(
        `SELECT * FROM approvals
          WHERE facility_ref = ? AND product_category = ? AND status = 'active'
            AND effective_from <= ? AND (effective_until IS NULL OR effective_until > ?)
          ORDER BY version DESC`,
      )
      .all(facilityRef, productCategory, at, at);
    const hit = rows.find((row) => scopeCovers(row.scope, hsCode, form));
    return hit ? { ...hit, scope: parseScope(hit.scope) } : null;
  }

  function listApprovals(supplierRef) {
    return db
      .prepare(
        `SELECT a.* FROM approvals a JOIN facilities f ON f.facility_ref = a.facility_ref
          WHERE f.supplier_ref = ? ORDER BY a.facility_ref, a.product_category, a.version DESC`,
      )
      .all(supplierRef)
      .map((row) => ({ ...row, scope: parseScope(row.scope) }));
  }

  // ---------- 采购意向 ----------

  function createIntention(input) {
    const buyer_ref = required(input.buyer_ref, "buyer_ref");
    const supplier_ref = required(input.supplier_ref, "supplier_ref");
    const facility_ref = required(input.facility_ref, "facility_ref");
    const product_category = required(input.product_category, "product_category");
    const hs_code = required(input.hs_code, "hs_code");
    const form = required(input.form, "form");
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new DomainError("VALIDATION_ERROR", "数量必须为正数", { status: 400 });
    }
    getFacilityOfSupplier(facility_ref, supplier_ref);
    const category = getCategory(product_category);
    if (!hsCodeCovered(category.hs_codes, hs_code)) {
      throw new DomainError("VALIDATION_ERROR", "hs 编码不属于该产品类别", {
        status: 400,
        details: { product_category, hs_code },
      });
    }
    const intention_id = newId("int");
    const ts = nowIso();
    db.prepare(
      `INSERT INTO purchase_intentions(intention_id, buyer_ref, supplier_ref, facility_ref,
                                      product_category, hs_code, form, quantity, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'negotiating', ?, ?)`,
    ).run(intention_id, buyer_ref, supplier_ref, facility_ref, product_category, hs_code, form, quantity, ts, ts);
    return getIntention(intention_id);
  }

  function getIntention(intentionId) {
    const row = db.prepare("SELECT * FROM purchase_intentions WHERE intention_id = ?").get(intentionId);
    if (!row) {
      throw new DomainError("NOT_FOUND", `采购意向不存在：${intentionId}`, { status: 404 });
    }
    return row;
  }

  function setIntentionStatus(intentionId, ...allowed) {
    const intention = getIntention(intentionId);
    if (!allowed.includes(intention.status)) {
      throw new DomainError(
        "INVALID_STATE",
        `采购意向当前状态为 ${intention.status}，不允许此操作`,
        { status: 409, details: { status: intention.status, allowed } },
      );
    }
    return intention;
  }

  function confirmIntention(intention_id) {
    return withTransaction(() => {
      setIntentionStatus(intention_id, "negotiating");
      db.prepare("UPDATE purchase_intentions SET status = 'confirmed', updated_at = ? WHERE intention_id = ?").run(
        nowIso(),
        intention_id,
      );
      return getIntention(intention_id);
    });
  }

  // 买方退出：只有尚未确认的洽谈需求会被释放。
  function withdrawIntention(intention_id) {
    return withTransaction(() => {
      setIntentionStatus(intention_id, "negotiating");
      db.prepare("UPDATE purchase_intentions SET status = 'withdrawn', updated_at = ? WHERE intention_id = ?").run(
        nowIso(),
        intention_id,
      );
      return getIntention(intention_id);
    });
  }

  function listIntentions(supplierRef, { status } = {}) {
    if (status) {
      return db
        .prepare("SELECT * FROM purchase_intentions WHERE supplier_ref = ? AND status = ? ORDER BY created_at DESC")
        .all(supplierRef, status);
    }
    return db
      .prepare("SELECT * FROM purchase_intentions WHERE supplier_ref = ? ORDER BY created_at DESC")
      .all(supplierRef);
  }

  // ---------- 意向转订单（硬门禁） ----------

  function convertIntention(intention_id) {
    return withTransaction(() => {
      const intention = setIntentionStatus(intention_id, "confirmed");

      // 门禁一：生产设施必须已注册。
      if (!hasActiveRegistration(intention.facility_ref)) {
        throw new DomainError(
          "FACILITY_NOT_REGISTERED",
          "设施未完成注册，采购意向不能转为可履约订单",
          { status: 409, details: { facility_ref: intention.facility_ref } },
        );
      }

      // 门禁二：货物必须落在当前有效批准范围内。
      const approval = findEffectiveApproval(
        intention.facility_ref,
        intention.product_category,
        intention.hs_code,
        intention.form,
      );
      if (!approval) {
        throw new DomainError(
          "OUT_OF_APPROVAL_SCOPE",
          "货物超出有效批准范围（或尚无批准），采购意向不能转为可履约订单",
          {
            status: 409,
            details: {
              facility_ref: intention.facility_ref,
              product_category: intention.product_category,
              hs_code: intention.hs_code,
              form: intention.form,
            },
          },
        );
      }

      const order_id = newId("ord");
      const ts = nowIso();
      db.prepare(
        `INSERT INTO orders(order_id, intention_id, approval_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?)`,
      ).run(order_id, intention_id, approval.approval_id, ts, ts);
      db.prepare("UPDATE purchase_intentions SET status = 'converted', updated_at = ? WHERE intention_id = ?").run(
        ts,
        intention_id,
      );
      return {
        order: db.prepare("SELECT * FROM orders WHERE order_id = ?").get(order_id),
        approval: { approval_id: approval.approval_id, version: approval.version },
      };
    });
  }

  function listOrders(supplierRef) {
    return db
      .prepare(
        `SELECT o.*, i.buyer_ref, i.supplier_ref, i.hs_code, i.form
           FROM orders o JOIN purchase_intentions i ON i.intention_id = o.intention_id
          WHERE i.supplier_ref = ? ORDER BY o.created_at DESC`,
      )
      .all(supplierRef);
  }

  // ---------- 通关批次 ----------

  function declaredQuantity(orderId) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(b.quantity), 0) AS total
           FROM customs_batches b WHERE b.order_id = ? AND b.status IN ('declared','cleared')`,
      )
      .get(orderId);
    return row.total;
  }

  function declareBatch(input) {
    const order_id = required(input.order_id, "order_id");
    const hs_code = required(input.hs_code, "hs_code");
    const form = required(input.form, "form");
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new DomainError("VALIDATION_ERROR", "数量必须为正数", { status: 400 });
    }
    return withTransaction(() => {
      const order = db.prepare("SELECT * FROM orders WHERE order_id = ?").get(order_id);
      if (!order) {
        throw new DomainError("NOT_FOUND", `订单不存在：${order_id}`, { status: 404 });
      }
      if (order.status !== "open") {
        throw new DomainError("INVALID_STATE", `订单状态为 ${order.status}，不能申报批次`, { status: 409 });
      }
      const intention = getIntention(order.intention_id);
      if (intention.hs_code !== hs_code || intention.form !== form) {
        throw new DomainError("OUT_OF_APPROVAL_SCOPE", "批次货物必须与订单意向的 hs 编码和形态一致", {
          status: 409,
          details: { ordered: { hs_code: intention.hs_code, form: intention.form }, declared: { hs_code, form } },
        });
      }
      if (declaredQuantity(order_id) + quantity > intention.quantity + 1e-9) {
        throw new DomainError("INVALID_STATE", "批次累计数量超出订单意向数量", {
          status: 409,
          details: { ordered: intention.quantity, already_declared: declaredQuantity(order_id) },
        });
      }

      // 申报时按当前有效批准重新校验，并冻结解析到的批准版本；
      // 许可更新只影响此后申报的新批次，不动已申报批次。
      const approval = findEffectiveApproval(
        intention.facility_ref,
        intention.product_category,
        hs_code,
        form,
      );
      if (!approval) {
        throw new DomainError(
          "OUT_OF_APPROVAL_SCOPE",
          "当前没有覆盖该货物的有效批准，批次不能申报",
          { status: 409, details: { hs_code, form } },
        );
      }

      const batch_ref = input.batch_ref || newId("bat");
      const declared_at = nowIso();
      db.prepare(
        `INSERT INTO customs_batches(batch_ref, order_id, approval_id, hs_code, form, quantity,
                                     status, declared_at)
         VALUES (?, ?, ?, ?, ?, ?, 'declared', ?)`,
      ).run(batch_ref, order_id, approval.approval_id, hs_code, form, quantity, declared_at);
      return db.prepare("SELECT * FROM customs_batches WHERE batch_ref = ?").get(batch_ref);
    });
  }

  function setBatchStatus(batchRef, status, clearedAt) {
    const row = db.prepare("SELECT * FROM customs_batches WHERE batch_ref = ?").get(batchRef);
    if (!row) {
      throw new DomainError("NOT_FOUND", `通关批次不存在：${batchRef}`, { status: 404 });
    }
    if (row.status !== "declared") {
      throw new DomainError("INVALID_STATE", `批次状态为 ${row.status}，不能变更为 ${status}`, {
        status: 409,
      });
    }
    db.prepare("UPDATE customs_batches SET status = ?, cleared_at = ? WHERE batch_ref = ?").run(
      status,
      clearedAt,
      batchRef,
    );
    return db.prepare("SELECT * FROM customs_batches WHERE batch_ref = ?").get(batchRef);
  }

  function clearBatch(batch_ref) {
    return withTransaction(() => {
      const batch = setBatchStatus(batch_ref, "cleared", nowIso());
      // 清关数量达到意向数量时订单自动履约完结。
      const order = db.prepare("SELECT * FROM orders WHERE order_id = ?").get(batch.order_id);
      const intention = getIntention(order.intention_id);
      if (order.status === "open" && declaredQuantity(order.order_id) + 1e-9 >= intention.quantity) {
        db.prepare("UPDATE orders SET status = 'fulfilled', updated_at = ? WHERE order_id = ?").run(
          nowIso(),
          order.order_id,
        );
      }
      return db.prepare("SELECT * FROM customs_batches WHERE batch_ref = ?").get(batch_ref);
    });
  }

  function rejectBatch(batch_ref) {
    return withTransaction(() => setBatchStatus(batch_ref, "rejected", null));
  }

  function listBatches(supplierRef) {
    return db
      .prepare(
        `SELECT b.* FROM customs_batches b
           JOIN orders o ON o.order_id = b.order_id
           JOIN purchase_intentions i ON i.intention_id = o.intention_id
          WHERE i.supplier_ref = ? ORDER BY b.declared_at DESC`,
      )
      .all(supplierRef);
  }

  // ---------- 供应商门户 ----------

  function supplierPortal(supplierRef) {
    getSupplier(supplierRef);
    return {
      supplier: getSupplier(supplierRef),
      registrations: listRegistrations(supplierRef),
      supplement_requests: listSupplementRequests(supplierRef),
      active_approvals: listApprovals(supplierRef).filter((a) => a.status === "active"),
      buyer_confirmations: listIntentions(supplierRef).filter((i) =>
        ["confirmed", "converted"].includes(i.status),
      ),
      orders: listOrders(supplierRef),
      batches: listBatches(supplierRef),
    };
  }

  // ---------- 平台统计（四个口径互不混淆） ----------

  function platformStats() {
    const at = nowIso();
    const negotiatingIntentions = db
      .prepare("SELECT COUNT(*) AS c FROM purchase_intentions WHERE status = 'negotiating'")
      .get().c;
    const negotiatingBuyers = db
      .prepare("SELECT COUNT(DISTINCT buyer_ref) AS c FROM purchase_intentions WHERE status = 'negotiating'")
      .get().c;
    const confirmedIntentions = db
      .prepare("SELECT COUNT(*) AS c FROM purchase_intentions WHERE status = 'confirmed'")
      .get().c;
    const ordersCreated = db.prepare("SELECT COUNT(*) AS c FROM orders").get().c;

    const approvedSuppliers = db
      .prepare(
        `SELECT COUNT(DISTINCT f.supplier_ref) AS c FROM approvals a
           JOIN facilities f ON f.facility_ref = a.facility_ref
          WHERE a.status = 'active' AND a.effective_from <= ?
            AND (a.effective_until IS NULL OR a.effective_until > ?)`,
      )
      .get(at, at).c;
    const activeApprovals = db
      .prepare(
        `SELECT COUNT(*) AS c FROM approvals
          WHERE status = 'active' AND effective_from <= ?
            AND (effective_until IS NULL OR effective_until > ?)`,
      )
      .get(at, at).c;

    const clearedBatches = db
      .prepare("SELECT COUNT(*) AS c FROM customs_batches WHERE status = 'cleared'")
      .get().c;
    const clearedSuppliers = db
      .prepare(
        `SELECT COUNT(DISTINCT i.supplier_ref) AS c FROM customs_batches b
           JOIN orders o ON o.order_id = b.order_id
           JOIN purchase_intentions i ON i.intention_id = o.intention_id
          WHERE b.status = 'cleared'`,
      )
      .get().c;

    // 复购：同一买方对同一供应商已有两笔及以上发生实际清关的订单。
    const repeatPairs = db
      .prepare(
        `SELECT i.buyer_ref AS buyer_ref, i.supplier_ref AS supplier_ref,
                COUNT(DISTINCT o.order_id) AS cleared_orders,
                COUNT(*) AS cleared_batches
           FROM customs_batches b
           JOIN orders o ON o.order_id = b.order_id
           JOIN purchase_intentions i ON i.intention_id = o.intention_id
          WHERE b.status = 'cleared'
          GROUP BY i.buyer_ref, i.supplier_ref
         HAVING COUNT(DISTINCT o.order_id) >= 2`,
      )
      .all();
    const repeatBatches = repeatPairs.reduce((sum, pair) => sum + pair.cleared_batches, 0);

    return {
      generated_at: at,
      discussions: {
        negotiating_intentions: negotiatingIntentions,
        distinct_buyers: negotiatingBuyers,
        confirmed_intentions: confirmedIntentions,
      },
      admitted_enterprises: {
        suppliers: approvedSuppliers,
        active_approvals: activeApprovals,
      },
      actual_customs: {
        cleared_batches: clearedBatches,
        distinct_suppliers: clearedSuppliers,
        converted_orders: ordersCreated,
      },
      repeat_purchases: {
        buyer_supplier_pairs: repeatPairs.length,
        cleared_batches_in_repeat_pairs: repeatBatches,
        pairs: repeatPairs,
      },
    };
  }

  return {
    DomainError,
    // 基础资料
    upsertCategory,
    listCategories,
    getCategory,
    upsertAuthority,
    registerSupplier,
    getSupplierByToken,
    getSupplier,
    upsertFacility,
    getFacility,
    // 注册
    submitRegistration,
    markRegistered,
    setRegistrationStatus,
    listRegistrations,
    hasActiveRegistration,
    // 材料
    submitMaterial,
    listMaterials,
    requestSupplement,
    resolveSupplement,
    listSupplementRequests,
    // 批准
    grantApproval,
    getApproval,
    findEffectiveApproval,
    listApprovals,
    // 意向与订单
    createIntention,
    getIntention,
    confirmIntention,
    withdrawIntention,
    listIntentions,
    convertIntention,
    listOrders,
    // 批次
    declareBatch,
    clearBatch,
    rejectBatch,
    listBatches,
    // 门户与统计
    supplierPortal,
    platformStats,
  };
}

module.exports = { createDomain, DomainError, scopeCovers, hsCodeCovered };
