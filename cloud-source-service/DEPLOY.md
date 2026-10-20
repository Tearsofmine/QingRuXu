# 清如许私人后台 v36.8

已接入原 GitHub Pages 手机 App；这是 API 后台，访问根网址只显示健康状态，不提供阅读器网页。

Render 配置：Node，main，Root Directory=cloud-source-service，Build=npm ci --omit=dev，Start=npm start，Instance=Free，Health Check Path=/health。现有服务与方案不用重建。

QRX_ALLOWED_ORIGIN=https://tearsofmine.github.io（不含路径或末尾斜杠）。QRX_API_TOKEN 是平台生成的随机私人密钥；升级时保留原值，不要提交到仓库、聊天、日志或截图中。手机“我的 → 私人书源”本地保存该密钥；已经连接的设备无需重新填写。

接口只允许固定的只读书源操作。新 /qrx-api/catalog 仍需 Bearer 密钥及 X-Qrx-Client 标记，并校验网页来源；用于手动检查新目录，不下载全书或后台定时抓取。没有密钥时应返回 401。

免费后台可能休眠、重启并丢失临时预览缓存；重新预览即可。书籍、书签与进度保存在设备 IndexedDB，不在服务器磁盘。手机 v36.8 数据库升至 v3，应保留兼容 v3 的前端，不直接回退只支持 v2 的旧网页。

第三方转载授权未核实；不绕过付费、登录或验证码，也不承诺所有书源一直可达。
