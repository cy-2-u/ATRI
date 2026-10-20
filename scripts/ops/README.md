# scripts/ops — 一次性运维脚本

这些脚本**不参与构建、测试或运行**，是开发过程中用来操作远程主机的临时工具。
保留它们是为了留下操作记录，需要时可以直接复用。

| 脚本               | 用途                                                                     | 敏感信息                   |
| ------------------ | ------------------------------------------------------------------------ | -------------------------- |
| `remote.mjs`       | 通过 SSH 在目标主机执行命令、运行脚本、拉取备份，或进入容器/宿主机 shell | 密码从 argv 传入           |
| `sandbox-debug.sh` | 在服务器上排查沙箱挂载、开关状态和文件时间线的一次性脚本                 | 从服务器 .env 读取管理密码 |

`remote.mjs` 把原来五个各自复制 askpass/SSH 逻辑的脚本合并成一个入口：

```sh
node scripts/ops/remote.mjs ssh    <host> <user> <password> <command...>
node scripts/ops/remote.mjs script <host> <user> <password> <local-script>
node scripts/ops/remote.mjs scp    <host> <user> <password> <remote-dir> <local-dir>
node scripts/ops/remote.mjs container <host> <password> <snippet-file>
node scripts/ops/remote.mjs host      <host> <password> <snippet-file>
```

**为什么放在子目录里**：`scripts/` 根目录只保留 `package.json` 真正调用的入口
（`build.mjs`、`test.mjs`、`backup.ts`、`restore.ts`）。API 配对检查和烟雾测试已经合并进
`test.mjs`（`--smoke`），根目录不再单独留脚本。这里的脚本没有任何引用，混在一起会让
"这个文件还要不要"变成每次都要重新判断的问题。

`remote.mjs` 会接触主机登录，因此不要在不受控的环境里运行。
