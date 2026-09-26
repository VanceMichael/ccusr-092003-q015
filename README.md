# 东盟商品输华准入接续

东盟供应商从展会接洽、材料递交、设施获准到首批通关形成多个不可混淆的业务阶段。
现场常把“见过采购商”误写成“已经获准输华”，本服务以独立状态机和硬门禁防止
洽谈商机越权成为可履约订单。

本服务通过 HTTP 接口交换业务记录，并使用 SQLite 文件保存状态。`PORT` 指定监听端口，
`DATABASE_PATH` 指定数据文件；`fixtures/example.json` 提供不含真实身份的本地示例
（泰国冷冻榴莲、越南燕窝两条接续线），`contracts/entities.json` 记录字段约定，
`docs/domain.md` 描述阶段口径与不变量。

## 本地开发

运行 `make migrate` 初始化数据文件，`make test` 执行现有自动化检查，`make run` 启动服务。
也可以使用 `docker compose up --build` 在隔离容器中运行，宿主机端口由 `APP_PORT` 调整。

## 接续流程（接口顺序）

1. 基础资料：`PUT /categories/:code` → `PUT /authorities/:ref` →
   `PUT /suppliers/:ref` → `PUT /facilities/:ref`
2. 材料递交：`POST /materials`（展会与企业重复递交同摘要材料时自动合并来源）；
   主管机关可 `POST /materials/:id/supplement-requests` 要求补件。
3. 设施注册：`POST /facilities/:ref/registrations` 递交，
   `POST /registrations/mark-registered` 登记获准。
4. 批准授予：`POST /approvals`，范围为 `{hs_codes, forms}`；重复授予产生新版本。
5. 采购意向：`POST /intentions` → `POST /intentions/:id/confirm`。
   - 未确认前买方可 `POST /intentions/:id/withdraw` 退出，仅释放该笔未确认需求。
   - `POST /intentions/:id/convert` 受两道门禁：设施未注册 →
     `409 FACILITY_NOT_REGISTERED`；货物超出有效批准范围 →
     `409 OUT_OF_APPROVAL_SCOPE`。
6. 通关批次：`POST /orders/:id/batches` 申报（冻结当时批准版本并重新校验范围），
   `POST /batches/:ref/clear` 清关。许可更新不影响已申报批次。
7. 视图：供应商用 `Authorization: Bearer <access_token>` 访问 `GET /portal`
   查看补件、有效许可与买方确认；`GET /stats` 分洽谈、获准企业、实际通关、复购
   四个口径统计。
