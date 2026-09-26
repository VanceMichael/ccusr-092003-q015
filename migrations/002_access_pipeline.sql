-- 供应商准入接续：产品类别 / 设施 / 主管机关 / 材料版本 / 批准范围 / 采购意向 / 通关批次
-- 阶段顺序不可跨越：洽谈(open intention) -> 获准(facility registered + approval in force)
--   -> 买方确认(confirmed intention -> fulfilled order) -> 通关(cleared shipment) -> 复购
-- 所有时间由应用层以带偏移量的 ISO 8601 字符串写入。

-- 产品类别
CREATE TABLE IF NOT EXISTS product_categories (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    default_authority_code TEXT,
    created_at TEXT NOT NULL
);

-- 主管机关（如海关总署，负责输华准入注册与批准）
CREATE TABLE IF NOT EXISTS competent_authorities (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- 供应商：对外只用引用编号，门户密钥保存 sha256 摘要
CREATE TABLE IF NOT EXISTS suppliers (
    ref TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    secret_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- 生产设施：注册状态是硬闸门，未注册设施的商机永远不能转成订单
CREATE TABLE IF NOT EXISTS facilities (
    ref TEXT PRIMARY KEY,
    supplier_ref TEXT NOT NULL REFERENCES suppliers(ref),
    product_category TEXT NOT NULL REFERENCES product_categories(code),
    registration_status TEXT NOT NULL DEFAULT 'unregistered'
        CHECK (registration_status IN ('unregistered', 'registered')),
    registered_at TEXT,
    created_at TEXT NOT NULL
);

-- 材料夹：同一 供应商+设施+类别 只有一个逻辑材料夹，展会与企业重复递交在此合并
CREATE TABLE IF NOT EXISTS document_bundles (
    id INTEGER PRIMARY KEY,
    supplier_ref TEXT NOT NULL REFERENCES suppliers(ref),
    facility_ref TEXT NOT NULL REFERENCES facilities(ref),
    product_category TEXT NOT NULL REFERENCES product_categories(code),
    current_revision_no INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE (supplier_ref, facility_ref, product_category)
);

-- 材料版本：只有内容发生变化才产生新版本；重复递交并入当前版本的来源
CREATE TABLE IF NOT EXISTS document_revisions (
    id INTEGER PRIMARY KEY,
    bundle_id INTEGER NOT NULL REFERENCES document_bundles(id),
    revision_no INTEGER NOT NULL,
    digest_sha256 TEXT NOT NULL,
    submitted_via TEXT NOT NULL CHECK (submitted_via IN ('expo', 'enterprise')),
    created_at TEXT NOT NULL,
    UNIQUE (bundle_id, revision_no)
);

CREATE TABLE IF NOT EXISTS document_revision_items (
    id INTEGER PRIMARY KEY,
    revision_id INTEGER NOT NULL REFERENCES document_revisions(id),
    item_code TEXT,
    document_ref TEXT NOT NULL,
    document_sha256 TEXT NOT NULL,
    UNIQUE (revision_id, document_ref)
);

-- 来源合并：同一份文件可由展会(expo)与企业(enterprise)分别递交，各自留痕但不产生新版本
CREATE TABLE IF NOT EXISTS document_sources (
    id INTEGER PRIMARY KEY,
    revision_item_id INTEGER NOT NULL REFERENCES document_revision_items(id),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('expo', 'enterprise')),
    source_ref TEXT NOT NULL,
    received_at TEXT NOT NULL,
    UNIQUE (revision_item_id, source_kind, source_ref)
);

-- 补件请求：供应商门户展示待补材料，随新版本中对应 item_code 文件的递交自动核销
CREATE TABLE IF NOT EXISTS supplement_requests (
    id INTEGER PRIMARY KEY,
    bundle_id INTEGER NOT NULL REFERENCES document_bundles(id),
    item_code TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'submitted', 'waived')),
    requested_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_revision_id INTEGER REFERENCES document_revisions(id)
);

-- 批准（许可）：按时间窗生效，许可更新通过新行表达；旧批次保留其批准快照
CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY,
    facility_ref TEXT NOT NULL REFERENCES facilities(ref),
    product_category TEXT NOT NULL REFERENCES product_categories(code),
    authority_code TEXT NOT NULL REFERENCES competent_authorities(code),
    scope_summary TEXT NOT NULL DEFAULT '',
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    supersedes_id INTEGER REFERENCES approvals(id),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_facility_category
    ON approvals (facility_ref, product_category);

-- 批准范围明细：货物超出范围时即使设施已注册也不能转单
CREATE TABLE IF NOT EXISTS approval_scope_items (
    approval_id INTEGER NOT NULL REFERENCES approvals(id),
    item_code TEXT NOT NULL,
    PRIMARY KEY (approval_id, item_code)
);

-- 采购意向（洽谈线索）：退出仅在 open 状态允许，确认后不可撤
CREATE TABLE IF NOT EXISTS purchase_intentions (
    id INTEGER PRIMARY KEY,
    ref TEXT NOT NULL UNIQUE,
    supplier_ref TEXT NOT NULL REFERENCES suppliers(ref),
    facility_ref TEXT NOT NULL REFERENCES facilities(ref),
    product_category TEXT NOT NULL REFERENCES product_categories(code),
    scope_item TEXT NOT NULL,
    buyer_ref TEXT NOT NULL,
    quantity_kg REAL NOT NULL CHECK (quantity_kg > 0),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'confirmed', 'withdrawn')),
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    withdrawn_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_intentions_supplier ON purchase_intentions (supplier_ref);
CREATE INDEX IF NOT EXISTS idx_intentions_buyer ON purchase_intentions (buyer_ref);

-- 可履约订单：仅在准入闸门通过时由已确认意向生成，并固化所依据的批准
CREATE TABLE IF NOT EXISTS fulfilled_orders (
    id INTEGER PRIMARY KEY,
    ref TEXT NOT NULL UNIQUE,
    intention_id INTEGER NOT NULL UNIQUE REFERENCES purchase_intentions(id),
    supplier_ref TEXT NOT NULL,
    facility_ref TEXT NOT NULL,
    product_category TEXT NOT NULL REFERENCES product_categories(code),
    scope_item TEXT NOT NULL,
    buyer_ref TEXT NOT NULL,
    quantity_kg REAL NOT NULL CHECK (quantity_kg > 0),
    approval_id INTEGER NOT NULL REFERENCES approvals(id),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_supplier ON fulfilled_orders (supplier_ref);

-- 通关批次：订舱时按计划日期重新过闸并固化批准快照，许可更新只影响之后的新批次
CREATE TABLE IF NOT EXISTS customs_shipments (
    id INTEGER PRIMARY KEY,
    shipment_ref TEXT NOT NULL UNIQUE,
    order_id INTEGER NOT NULL REFERENCES fulfilled_orders(id),
    approval_id INTEGER NOT NULL REFERENCES approvals(id),
    planned_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cleared')),
    created_at TEXT NOT NULL,
    cleared_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON customs_shipments (order_id);
