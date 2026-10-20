cd /root/ATRI
PW=$(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2-)
COOKIE=$(curl -s -i -X POST http://127.0.0.1:3000/api/login -H 'Content-Type: application/json' \
  --data-binary "{\"password\":\"$PW\"}" | sed -n 's/^set-cookie: \(atri_session=[^;]*\).*/\1/ip' | tr -d '\r')

echo "=========== /api/sandbox 报告的内容 ==========="
curl -s -H "Cookie: $COOKIE" http://127.0.0.1:3000/api/sandbox | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const o=JSON.parse(s);
  console.log(JSON.stringify(o,null,2));
});'

echo ""
echo "=========== 沙箱目录里的文件时间线 ==========="
ls -la --time-style=full-iso /sandbox 2>/dev/null || docker exec atri-atri-1 sh -c 'ls -la --time-style=full-iso /sandbox; echo "---"; ls -la --time-style=full-iso /sandbox/atri'

echo ""
echo "=========== 沙箱开关状态（配置里）==========="
curl -s -H "Cookie: $COOKIE" http://127.0.0.1:3000/api/config | tr ',' '\n' | grep -E 'sandbox'

echo ""
echo "=========== 代理容器是否碰过 /sandbox ==========="
for c in cpamp-cpa-manager-plus-1 cpamp-cli-proxy-api-1; do
  echo "--- $c ---"
  docker inspect $c --format '{{range .Mounts}}  {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
done

echo ""
echo "=========== 有没有容器/进程叫 proxy 或 cli-proxy 引用 atri 卷 ==========="
docker ps -a --format '{{.Names}}' | while read n; do
  if docker inspect "$n" 2>/dev/null | grep -q 'atri_atri-sandbox\|0c95359f'; then echo "  $n references atri sandbox volume"; fi
done
echo "(以上为空表示没有)"
