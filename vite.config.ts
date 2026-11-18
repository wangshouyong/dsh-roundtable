import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { imPersistPlugin } from './src/dev/persist-plugin'

export default defineConfig({
  plugins: [react(), imPersistPlugin()],
  server: { port: 5173 },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 隔离测试数据根记忆文件，绝不写用户真实 home（见 test/setup.ts）。
    setupFiles: ['./test/setup.ts'],
    // 默认并发会把 91 个 worker 同时拉起：本机 Windows tmpdir IO 抢满后，
    // 写 500+ 文件、并发落盘这类 IO 密集用例会假超时（门禁不确定）。
    // 限并发换确定性；CI（windows-latest）同样收益。（vitest 5 只接受 maxWorkers）
    maxWorkers: 4,
  },
})
