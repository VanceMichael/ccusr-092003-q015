# 领域资料

东盟供应商从展会接洽、材料递交、设施获准到首批通关形成多个不可混淆的业务阶段。东博会现场最常见的错误，是把“见过采购商”（洽谈线索）误写成“已经获准输华”（设施注册且批准在生效范围与时间窗内），导致企业无法判断下一步该补材料、等批准还是安排首批货。

## 阶段与接续顺序

1. **洽谈（talk）**：采购意向 `purchase_intentions`，状态 `open`。仅代表采购商接洽，不构成任何准入结论。
2. **材料（documents）**：展会与企业向同一“供应商 × 设施 × 产品类别”材料夹递交材料，内容变化才产生新的 `application_revision`；内容相同的重复递交只合并来源。主管机关可提出补件请求，新版本包含对应 `item_code` 文件时自动核销。
3. **获准（approved）**：两个独立条件——`facilities.registration_status=registered`，且存在覆盖**具体货物范围项**、在生效时间窗内的 `approvals`。注意区分：企业获准了“冷冻榴莲果肉”，并不等于“整粒 Monthong”获准；燕窝企业获准了“加工燕窝”，并不等于“毛燕”获准。
4. **买方确认（confirmed）**：买方确认意向后需求锁定；退出只允许发生在确认之前。
5. **可履约订单（fulfilled order）**：仅当意向已确认**且**准入闸门通过时生成，并固化所依据的 `approval_id`。
6. **通关批次（customs shipment）**：订舱时按 `planned_at` 再次过闸并固化批准快照；实际清关后置为 `cleared`。
7. **复购（repeat）**：同一买方实际通关达到 2 批及以上。

## 准入闸门（GET /gate）

对 设施 × 产品类别 × 范围项 × 时刻 判定，回答“下一步做什么”：

| status | next_action | 含义 |
| --- | --- | --- |
| `facility_unregistered` | `await_facility_registration` | 设施未在华注册，硬阻断 |
| `approval_not_in_force` | `submit_documents` | 尚未递交任何材料 |
| `approval_not_in_force` | `supplement_documents` | 存在未核销补件请求 |
| `approval_not_in_force` | `await_approval` | 材料齐但无覆盖该货物、在时间窗内的批准（含超范围） |
| `ready` | `arrange_first_shipment` | 可转单、可订舱 |

`status != ready` 时，商机转单（`POST /intentions/:ref/fulfill`）与订舱（`POST /shipments`）一律拒绝。

## 关键不变量

- 设施未注册或货物超出批准范围，商机绝不能转成可履约订单。
- 重复递交：同内容合并来源（`document_sources` 区分 `expo`/`enterprise` 并留 `source_ref`、`received_at`），不产生新版本。
- 许可更新只影响适用的新批次：批准以版本化时间窗保存，订舱按计划日期挑选适用许可；订单与批次固化 `approval_id` 快照，旧批次永不被追溯改写。
- 买方退出仅释放尚未确认的需求；已确认意向退出返回 `buyer_commitment_locked`。
- 统计分桶严格区分洽谈、获准企业/设施、可履约订单、实际通关、复购。

## 数据约定

外部主体使用不含真实身份信息的引用编号（`ref`）。交换时间采用带偏移量的 ISO 8601 字符串；原始材料只保存受控引用 `document_ref` 或 `document_sha256` 摘要；供应商门户密钥仅保存 `sha256` 摘要。`contracts/entities.json` 中的字段名称属于稳定接口约定，运行时数据文件位置由 `DATABASE_PATH` 决定。
