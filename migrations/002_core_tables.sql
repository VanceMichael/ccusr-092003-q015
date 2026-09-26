
-- 供应商准入接续核心表：产品类别、主管机关、供应商、生产设施、设施注册、
-- 材料与来源、补件请求、批准、采购意向、订单、通关批次。

CREATE TABLE IF NOT EXISTS product_categories (
    category_code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hs_codes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competent_authorities (
    authority_ref TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country_code TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
    supplier_ref TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    country_code TEXT NOT NULL,
    access_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facilities (
    facility_ref TEXT PRIMARY KEY,
    supplier_ref TEXT NOT NULL REFERENCES suppliers(supplier_ref),
    name TEXT NOT NULL,
    country_code TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facility_registrations (
    registration_id TEXT PRIMARY KEY,
    facility_ref TEXT NOT NULL REFERENCES facilities(facility_ref),
    authority_ref TEXT NOT NULL REFERENCES competent_authorities(authority_ref),
    status TEXT NOT NULL CHECK (status IN ('pending','registered','suspended','revoked')),
    registered_at TEXT,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_facility_registration
    ON facility_registrations(facility_ref, authority_ref);

CREATE TABLE IF NOT EXISTS materials (
    material_id TEXT PRIMARY KEY,
    supplier_ref TEXT NOT NULL REFERENCES suppliers(supplier_ref),
    facility_ref TEXT NOT NULL REFERENCES facilities(facility_ref),
    product_category TEXT NOT NULL REFERENCES product_categories(category_code),
    doc_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('submitted','under_review','accepted','rejected')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_material_content
    ON materials(supplier_ref, facility_ref, product_category, doc_type, content_hash);

-- 同一份材料可能由展会现场与企业各自递交，来源逐条记录、内容只保存一份。
CREATE TABLE IF NOT EXISTS material_sources (
    material_id TEXT NOT NULL REFERENCES materials(material_id),
    source_channel TEXT NOT NULL CHECK (source_channel IN ('expo','enterprise')),
    source_ref TEXT NOT NULL DEFAULT '',
    received_at TEXT NOT NULL,
    PRIMARY KEY (material_id, source_channel, source_ref)
);

CREATE TABLE IF NOT EXISTS supplement_requests (
    request_id TEXT PRIMARY KEY,
    material_id TEXT NOT NULL REFERENCES materials(material_id),
    detail TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','resolved')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    facility_ref TEXT NOT NULL REFERENCES facilities(facility_ref),
    product_category TEXT NOT NULL REFERENCES product_categories(category_code),
    authority_ref TEXT NOT NULL REFERENCES competent_authorities(authority_ref),
    scope TEXT NOT NULL,
    version INTEGER NOT NULL,
    effective_from TEXT NOT NULL,
    effective_until TEXT,
    status TEXT NOT NULL CHECK (status IN ('active','superseded','revoked')),
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_version
    ON approvals(facility_ref, product_category, version);

CREATE TABLE IF NOT EXISTS purchase_intentions (
    intention_id TEXT PRIMARY KEY,
    buyer_ref TEXT NOT NULL,
    supplier_ref TEXT NOT NULL REFERENCES suppliers(supplier_ref),
    facility_ref TEXT NOT NULL REFERENCES facilities(facility_ref),
    product_category TEXT NOT NULL REFERENCES product_categories(category_code),
    hs_code TEXT NOT NULL,
    form TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity > 0),
    status TEXT NOT NULL CHECK (status IN ('negotiating','confirmed','converted','withdrawn')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    intention_id TEXT NOT NULL UNIQUE REFERENCES purchase_intentions(intention_id),
    approval_id TEXT NOT NULL REFERENCES approvals(approval_id),
    status TEXT NOT NULL CHECK (status IN ('open','fulfilled','cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 批次在申报时冻结当时的批准版本；许可更新只影响之后申报的新批次。
CREATE TABLE IF NOT EXISTS customs_batches (
    batch_ref TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(order_id),
    approval_id TEXT NOT NULL REFERENCES approvals(approval_id),
    hs_code TEXT NOT NULL,
    form TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity > 0),
    status TEXT NOT NULL CHECK (status IN ('declared','cleared','rejected')),
    declared_at TEXT NOT NULL,
    cleared_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_batches_order ON customs_batches(order_id);
CREATE INDEX IF NOT EXISTS idx_intentions_supplier ON purchase_intentions(supplier_ref);
CREATE INDEX IF NOT EXISTS idx_intentions_buyer ON purchase_intentions(buyer_ref);
CREATE INDEX IF NOT EXISTS idx_approvals_facility ON approvals(facility_ref, product_category, status);

INSERT OR IGNORE INTO schema_migrations(version) VALUES ('002_core_tables');
