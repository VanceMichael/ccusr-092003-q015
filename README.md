# 东盟商品输华准入接续

东盟供应商从展会接洽、材料递交、设施获准到首批通关形成多个不可混淆的业务阶段。本服务把“见过采购商（洽谈）”与“已经获准输华（设施注册 + 批准在范围与时间窗内）”严格分开，并以准入闸门保证：**设施未注册或货物超出批准范围时，商机绝不能转成可履约订单**。

本服务通过 HTTP 接口交换业务记录，并使用 SQLite 文件保存状态（零第三方依赖，仅用 Node 内置模块）。`PORT` 指定监听端口，`DATABASE_PATH` 指定数据文件；`fixtures/example.json` 提供不含真实身份的本地示例，`contracts/entities.json` 记录稳定字段约定，`docs/domain.md` 说明阶段语义与不变量。

## 本地开发

运行 `make migrate` 初始化数据文件，`make test` 执行自动化检查，`make run` 启动服务。也可以使用 `docker compose up --build` 在隔离容器中运行，宿主机端口由 `APP_PORT` 调整。

## 接续流程（对应泰国冷冻榴莲示例）

1. 登记目录：`POST /categories`、`POST /authorities`、`POST /suppliers`、`POST /facilities`。
2. 展会洽谈：`POST /intentions` 登记采购意向（只是线索）；买家用 `POST /intentions/:ref/confirm` 确认。
3. 递交材料：`POST /documents`（`submitted_via` 为 `expo` 或 `enterprise`）。重复递交同内容材料只合并来源；内容变化才提升 `application_revision`。主管机关用 `POST /supplements` 要求补件，补件随新材料版本自动核销。
4. 设施注册：`POST /facilities/:ref/register`。
5. 授予许可：`POST /approvals`，给出 `approval_scope`（范围项数组）与 `effective_from/effective_to` 时间窗。许可更新发新许可并以 `supersedes_id` 作废旧窗口。
6. 查询下一步：`GET /gate?facility_ref=...&product_category=...&scope_item=...[&at=...]`，返回 `facility_unregistered` / `approval_not_in_force`（`submit_documents`、`supplement_documents`、`await_approval`）/ `ready`（`arrange_first_shipment`）。
7. 转可履约订单：`POST /intentions/:ref/fulfill`——未确认、设施未注册、超范围或批准未生效均被拒绝；成功后固化 `approval_id`。
8. 通关：`POST /shipments` 按 `planned_at` 再次过闸并固化批准快照，`POST /shipments/:ref/clear` 记录实际通关。许可更新只影响计划日期落入新窗口的新批次。
9. 买方退出：`POST /intentions/:ref/withdraw` 仅释放 `open` 意向；已确认意向返回 `403 buyer_commitment_locked`。

## 查询与视图

- `GET /intentions`（可按 `supplier_ref`、`buyer_ref`、`status` 过滤，加 `gate=1` 附带闸门判定）
- `GET /orders`、`GET /shipments`（可按 `status`、买卖方过滤）
- `GET /approvals`、`GET /document-bundles`、`GET /supplements`
- `GET /suppliers/:ref/portal`（供应商登录：请求头 `x-supplier-secret`；返回我的补件、有效许可与买方确认）
- `GET /stats`（平台统计：洽谈 `talks`、获准 `approved`、可履约订单 `fulfilled_orders`、实际通关 `customs`、复购 `repeat`）

## 错误约定

闸门类拒绝使用 `403`：`facility_not_registered`、`approval_not_in_force`、`shipment_outside_approval`、`buyer_commitment_locked`；状态冲突使用 `409`（如 `intention_withdrawn`）。所有错误响应为 `{ "error": "code", "details": ... }`。
