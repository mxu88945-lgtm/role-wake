参考来源：
- https://github.com/ssxl0126/WrenWen
- https://github.com/ssxl0126/WrenWen/blob/main/docs/02-%E6%AC%B2%E6%9C%9B%E9%A9%B1%E5%8A%A8%E5%86%85%E6%A0%B8.md
- https://github.com/ssxl0126/WrenWen/blob/main/architecture/07-%E5%94%A4%E9%86%92%E7%B3%BB%E7%BB%9F.md

本任务只借鉴思路，不复制代码：驱动值随时间变化、唤醒前有阈值与频率闸、模型拥有“不发”的判断权、用户活跃时不打扰。实现采用四种心思（想念、分享欲、担心、好奇），北京时间静默时段、3 小时最小间隔、每天 4 条和 30 分钟最近聊天保护。WrenWen 文档明确指出不能把定时器本身当作角色意愿，也强调“唤醒回合”应由系统保证触发、是否发言由角色判断；本项目保留这一分工。
