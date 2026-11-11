import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../scripts/hooks/monitor-allow.mjs';

const allowed = (command) => decide({ tool_name: 'Monitor', tool_input: { command } }).allow;

const ALLOW = [
  'tail -f run.log | grep -E --line-buffered "DONE|FAIL|Traceback"',
  'until grep -q "Ready in" dev.log; do sleep 1; done',
  'while true; do s=$(git status --short | wc -l); echo "$s"; sleep 30; done',
  'prev=""; while true; do cur=$(gh pr checks 12 --json name,bucket); echo "$cur"; sleep 30; done',
  'curl -sS -o /dev/null -w "%{http_code}" https://example.com/health 2>&1 || true',
  'for f in a.log b.log; do tail -n 1 "$f"; done',
  'while read -r l; do echo "$l"; done < <(tail -f x.log)',
  'pgrep -f metro | wc -l',
  'git -C /tmp/repo log -1 --format=%h',
  'ls -la 2>/dev/null; echo "n=$((1+2))" # note',
  'find . -name "*.log" -mmin -5',
  'awk \'{print $1; fflush()}\' run.log',
  'sed -u -E "s/^x/y/" a.log',
  "tail -f a | sed -E 's#a#b#g'",
];

const ASK = [
  'rm -rf dist',
  'tail -f x.log; rm y',
  'while true; do mv a b; sleep 1; done',
  'echo $(rm x)',
  'echo "$(rm x)"',
  'echo `rm x`',
  'cat <(rm x)',
  'r"m" x',
  '\\rm x',
  '$CMD x',
  'bash -c "ls"',
  'sh run.sh',
  'node -e "1"',
  'python3 x.py',
  'xargs rm',
  'eval "ls"',
  'git push origin main',
  'git fetch',
  'git commit -m x',
  'git branch -D old',
  'git -c core.pager=rm log',
  'git diff --output=x',
  'gh pr merge 12',
  'gh pr close 12',
  'gh api -X DELETE repos/a/b',
  'curl -X POST https://example.com',
  'curl -sSXPOST https://example.com',
  'curl -d a=1 https://example.com',
  'curl -o out.txt https://example.com',
  'curl file:///etc/passwd',
  'echo hi > out.txt',
  'echo hi >> out.txt',
  'cat x &> out.txt',
  'cat <<EOF\nhi\nEOF',
  'tee out.txt',
  'sed -i s/a/b/ x',
  'find . -delete',
  'find . -exec rm {} +',
  'sort -o x y',
  'rg --pre rm x',
  'awk \'BEGIN{system("rm x")}\'',
  'awk \'{print > "x"}\' y',
  'kill -9 123',
  'ps aux',
  'pgrep -fl metro',
  'cat .env',
  'tail ~/.ssh/id_rsa',
  'cat ~/.aws/credentials',
  'echo $MY_API_TOKEN',
  'echo "${DATABASE_PASSWORD}"',
  "sed 's/a/b/w out' x",
  "sed '1e rm x' y",
  'PATH=/tmp ls',
  'foo() { rm x; }; foo',
];

for (const c of ALLOW) test(`allow: ${c}`, () => assert.equal(allowed(c), true));
for (const c of ASK) test(`ask: ${c}`, () => assert.equal(allowed(c), false));

test('other tools and websocket watches get no decision', () => {
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'ls' } }).allow, false);
  assert.equal(decide({ tool_name: 'Monitor', tool_input: { ws: { url: 'wss://x' } } }).allow, false);
});
