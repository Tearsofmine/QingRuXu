# 清如许私人书源后台

只部署后台；现有 GitHub Pages 网页和设备书架不变。不会上传小说、缓存或密钥。

## Render 手动创建 Web Service

- Repo: Tearsofmine/QingRuXu
- Branch: main
- Root Directory: cloud-source-service
- Runtime: Node
- Build Command: npm ci --omit=dev
- Start Command: npm start
- Instance: Free（不要选择付费方案）
- Health Check Path: /health
- QRX_ALLOWED_ORIGIN: https://tearsofmine.github.io（不含路径和末尾斜杠）
- QRX_API_TOKEN: 至少 32 位随机密钥，使用平台 Generate 生成；不要写到代码、截图或聊天里。

也可用仓库根目录 render.yaml 创建 Blueprint；该文件限定一个 Free Web Service，无数据库、付费磁盘和定时保活。

部署完成后 /health 仅显示服务就绪；API 没有密钥会返回 401。还需用手机实际测试书源可达性，再把 HTTPS 地址与私人密钥配置到清如许；目前 App 仍是 v36.6.1，尚未接上后台，不能把 health 成功当作手机找书成功。

免费实例会休眠/重启，临时预览可能失效，重新预览即可；阅读内容保存在设备端，不依赖服务器磁盘。免费版不保证可用性或来源可达性。第三方来源的转载授权未核实；不绕过付费、登录或验证码限制。
