import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// 客户端模块 id 必须等于 npm 包名：dsh-client-modules 按包名组装模块图，
// 加载 bundle 时校验 window.__ModuleLoader__.load({ id }) 与包名一致。
// 本仓发布名是带 scope 的 @dabuliu_wsy/dsh-im，不能再写死 'dsh-im'
// （否则 scoped 安装后客户端模块报 loaded without registering）。
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const moduleId = pkg.name

const innerPath = join('lib', 'client.inner.cjs')
const inner = await readFile(innerPath, 'utf8')
const wrapped = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(moduleId)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${inner}
		return module.exports;
	}
});
`
await writeFile(join('lib', 'client.js'), wrapped, 'utf8')
console.log(`wrote lib/client.js (module id: ${moduleId})`)
