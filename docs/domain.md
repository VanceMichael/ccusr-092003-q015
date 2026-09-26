# 领域资料

东盟供应商从展会接洽、材料递交、设施获准到首批通关形成多个不可混淆的业务阶段。
现场常见错误是把“见过采购商”（洽谈）误记为“已经获准输华”（有效批准），
本服务用独立状态与硬门禁保证二者不会相互冒充。

外部主体使用不含真实身份信息的引用编号。交换时间采用带偏移量的 ISO 8601 字符串，
原始材料只保存受控引用 `source_ref` 或 `sha256` 摘要（`content_hash`）。
`contracts/entities.json` 中的字段名称属于稳定接口约定，运行时数据文件位置由
`DATABASE_PATH` 决定。

## 阶段与口径

1. **洽谈**：采购意向 `negotiating`，仅代表见过采购商；可被买方撤回（释放需求）。
2. **确认**：买方确认意向 `confirmed`，仍非订单。
3. **获准**：设施在主管机关 `registered`，且存在覆盖具体货物的 `active` 批准。
4. **履约**：确认意向通过两道门禁转为订单，批次申报并清关。

平台统计 `/stats` 的四个桶互不重叠口径：`discussions`（洽谈）、
`admitted_enterprises`（获准企业）、`actual_customs`（实际通关）、
`repeat_purchases`（同一买方-供应商对清关 ≥2 批复购）。

## 核心不变量

- **门禁一（设施注册）**：意向转订单时，设施必须存在 `status=registered` 的注册记录，
  否则返回 `409 FACILITY_NOT_REGISTERED`。
- **门禁二（批准范围）**：意向转订单、批次申报时，必须存在覆盖 `hs_code + form` 的
  `active` 批准，否则返回 `409 OUT_OF_APPROVAL_SCOPE`。税目支持 4/6 位上位前缀
  （批准 `0811` 覆盖申报 `08119000`），形态必须精确匹配。
- **材料合并来源**：同一份材料（供应商+设施+类别+文件类型+摘要相同）重复递交时，
  只向 `material_sources` 追加一条来源（`expo` 展会 / `enterprise` 企业），
  不复制内容、不抬高版本。
- **批准版本化**：重新授予批准时旧版本置 `superseded`，版本号递增。
  批次在申报瞬间冻结 `approval_id`；许可更新只影响之后申报的新批次。
- **买方退出**：只有 `negotiating`（尚未确认）的意向可撤回为 `withdrawn`；
  已确认、已转单的需求不受影响。
- **数量约束**：同一订单累计申报（declared/cleared）数量不得超过意向数量。

## 供应商门户

`GET /portal`，以供应商 `access_token` 作为 `Authorization: Bearer` 令牌，
一次返回该供应商的：补件请求（未办结优先）、设施注册、有效许可、
买方确认（confirmed/converted 意向）、订单与批次。

## 主要接口

基础资料：`PUT /categories/:code`、`PUT /authorities/:ref`、
`PUT /suppliers/:ref`、`PUT /facilities/:ref`

注册：`POST /facilities/:ref/registrations`、`POST /registrations/mark-registered`

材料：`POST /materials`（重复递交返回 200+`merged:true`）、`GET /materials`、
`POST /materials/:id/supplement-requests`

批准：`POST /approvals`

意向：`POST /intentions`、`POST /intentions/:id/confirm`、
`POST /intentions/:id/withdraw`、`POST /intentions/:id/convert`

通关：`POST /orders/:id/batches`、`POST /batches/:ref/clear`、
`POST /batches/:ref/reject`

视图：`GET /portal`、`GET /stats`
