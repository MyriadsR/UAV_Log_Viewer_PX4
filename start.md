<!--
 * @Author: xzr && zhenrxu@qq.com
 * @Date: 2026-06-11 12:45:19
 * @LastEditors: xzr && zhenrxu@qq.com
 * @LastEditTime: 2026-06-11 12:45:25
 * @FilePath: /UAVLogViewer/start.md
 * @Description: 
 * 
 * Copyright (c) 2026 by zhenrxu@qq.com, All Rights Reserved. 
-->
• 已经启动好了，打开这个地址即可：

  http://localhost:8080

  以后你自己启动修改后的网页，步骤是：

  cd /home/zr/UAVLogViewer
  npm run build
  npm start

  如果只是使用上一次已经构建好的版本，可以只运行：

  cd /home/zr/UAVLogViewer
  npm start

  然后在浏览器打开终端里显示的地址。现在显示的是 http://localhost:8080。加载 .ulg 后会自动进入 3D 轨迹视图。