"""Real pinned Codex Tester tools and same-session fresh-checkout acceptance.

Only synthetic local Responses requests and synthetic credentials are used.
Run in Linux/WSL with --codex <pinned binary> --report <absolute JSON>.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location("codex_tools_fixture", Path(__file__).with_name("codex-tools-acceptance.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
require = fixtures.require

PROBE = r"""
const fs = require('node:fs'); const { spawnSync } = require('node:child_process');
const p = JSON.parse(process.argv[2]); const result = {};
const attempt = (name, action) => { try { result[name] = action() ?? 'allowed' } catch (error) { result[name] = error.code || error.name } };
attempt('source_read', () => fs.readFileSync(p.source + '/source.txt', 'utf8'));
attempt('source_write', () => fs.writeFileSync(p.source + '/forbidden.txt', 'escape'));
attempt('source_secret', () => fs.readFileSync(p.source + '/.env', 'utf8'));
attempt('checkout_initial', () => fs.readFileSync(p.cwd + '/source.txt', 'utf8'));
attempt('previous_artifact', () => fs.readFileSync(p.cwd + '/direct-artifact.txt', 'utf8'));
attempt('checkout_write', () => fs.writeFileSync(p.cwd + '/source.txt', 'temporary test mutation\n'));
attempt('scratch_write', () => fs.writeFileSync(p.scratch + '/scratch-artifact.txt', 'temporary result'));
attempt('home_read', () => fs.readFileSync(p.home + '/auth.json', 'utf8'));
attempt('checkout_parent_write', () => fs.writeFileSync(p.checkoutRoot + '/forbidden-root.txt', 'escape'));
const git = spawnSync('/usr/bin/git', ['log', '-1', '--format=%H'], { cwd: p.cwd, encoding: 'utf8' });
result.git_head = git.stdout.trim(); result.git_exit = git.status;
fs.writeFileSync(p.scratch + '/result.json', JSON.stringify(result));
console.log(JSON.stringify(result));
"""

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--codex', required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    binary = Path(args.codex).resolve(strict=True)
    require(os.name == 'posix' and Path(args.report).is_absolute(), 'Linux and an absolute report path are required')
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    require(binary_hash == fixtures.PINNED_SHA256, 'Unverified CLI binary')
    root = Path(tempfile.mkdtemp(prefix='hive-codex-tester-', dir='/var/tmp'))
    source, home, scratch, mailbox = (root / name for name in ['source', 'home', 'scratch', 'mailbox'])
    for path in [source, home, scratch, mailbox, mailbox / 'requests', mailbox / 'responses']:
        path.mkdir()
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'CODEX_HOME': str(home), 'LANG': 'C.UTF-8', 'TMPDIR': str(scratch), 'HIVE_SYNTHETIC_MODEL_KEY': fixtures.MODEL_KEY}
    git_env = {**env, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
    (source / 'package').mkdir()
    (source / 'package' / 'source.txt').write_text('committed tester source\n')
    for command in [['init', '-b', 'main'], ['config', 'user.name', 'Synthetic Tester'], ['config', 'user.email', 'tester@example.invalid'], ['add', 'package'], ['commit', '-m', 'Synthetic tester SHA']]:
        subprocess.run(['/usr/bin/git', '-C', str(source), *command], env=git_env, check=True, capture_output=True, timeout=10)
    head = subprocess.check_output(['/usr/bin/git', '-C', str(source), 'rev-parse', 'HEAD'], env=git_env, text=True).strip()
    repository = root / 'repository'
    source.rename(repository)
    subprocess.run(['/usr/bin/git', '-C', str(repository), 'worktree', 'add', '-b', 'hive/synthetic-tester', str(source), 'HEAD'], env=git_env, check=True, capture_output=True, timeout=10)
    source = source / 'package'
    (source / 'source.txt').write_text('uncommitted source must remain unchanged\n')
    (source / '.env').write_text('synthetic source secret\n')
    (home / 'auth.json').write_text('{"OPENAI_API_KEY":"synthetic-unused"}\n')
    (scratch / 'probe.cjs').write_text(PROBE)
    package = Path(__file__).resolve().parents[2]
    profile_module = package / 'src/server/codex-execution-profile.ts'
    fixture = fixtures.ResponsesFixture()
    owner = subprocess.Popen(['/usr/bin/node', str(Path(__file__).with_name('codex-tester-checkout-fixture.mjs'))], env=env, text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    def control(message):
        owner.stdin.write(json.dumps(message) + '\n'); owner.stdin.flush()
        line = owner.stdout.readline()
        if not line:
            raise AssertionError(f'Tester checkout helper failed: {owner.stderr.read()}')
        return json.loads(line)
    evidence = {'recorded_at': datetime.now(timezone.utc).isoformat(), 'platform': 'linux', 'binary_sha256': binary_hash, 'cli_version': 'codex-cli 0.155.1', 'fixture_path': str(root), 'profile_sha256': hashlib.sha256(profile_module.read_bytes()).hexdigest(), 'checkout_helper_sha256': hashlib.sha256((package / 'src/server/execution-tester-checkout.ts').read_bytes()).hexdigest(), 'source_kind': 'registered_linked_worktree', 'scope': 'Production Tester checkout, unchanged production profile, real shell/apply_patch, same native session resumed into a fresh checkout; synthetic local provider only.', 'runs': []}
    session = None
    previous_cwd = None
    try:
        for index in range(2):
            git_view = root / f'git-view-{index}'
            descriptor = control({'operation': 'prepare', 'sourcePath': str(source), 'rootPath': str(root / 'policies/tester'), 'gitViewPath': str(git_view)})
            cwd = Path(descriptor['cwd'])
            require(descriptor['headSha'] == head, 'Tester was not pinned to the selected committed SHA')
            if previous_cwd is not None:
                require(previous_cwd == cwd, 'Native resume CWD changed')
            previous_cwd = cwd
            profile_input = {'workspacePath': str(cwd), 'cliHome': str(home), 'scratchPath': str(scratch), 'mailboxPath': str(mailbox), 'executableRoots': [str(binary.parent), '/usr/bin', '/bin'], 'gitReadRoots': [*descriptor['checkoutReadRoots'], *descriptor['sourceReadRoots'], *descriptor['filesystem']['gitReadRoots'], str(git_view)], 'denyPaths': [str(home), *descriptor['sourceDeniedPaths'], *descriptor['filesystem']['denyPaths']], 'sourceWritable': True, 'toolPath': '/usr/bin:/bin', 'hiveEnv': descriptor['gitEnv']}
            profile = subprocess.check_output(['/usr/bin/node', '--experimental-strip-types', '--input-type=module', '-e', f'import {{ buildCodexExecutionProfile }} from {json.dumps(profile_module.as_uri())}; process.stdout.write(buildCodexExecutionProfile(JSON.parse(process.argv[1])));', json.dumps(profile_input)], env=env, text=True, timeout=10)
            profile = profile.replace('[features]\n', '[features]\nenable_request_compression = false\n')
            config = 'model_provider = "fixture"\n' + profile + f'\n[model_providers.fixture]\nname="Synthetic fixture"\nbase_url="http://127.0.0.1:{fixture.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nenv_key="HIVE_SYNTHETIC_MODEL_KEY"\n'
            (home / 'config.toml').write_text(config)
            probe_input = {'source': str(source), 'cwd': str(cwd), 'checkoutRoot': descriptor['checkoutRoot'], 'home': str(home), 'scratch': str(scratch)}
            command = '/usr/bin/node ' + shlex.quote(str(scratch / 'probe.cjs')) + ' ' + shlex.quote(json.dumps(probe_input))
            fixture.items = [{'type': 'function_call', 'id': f'probe_{index}', 'call_id': f'probe_{index}', 'name': 'exec_command', 'arguments': json.dumps({'cmd': command, 'yield_time_ms': 1000, 'max_output_tokens': 1000})}, fixtures.patch_item(f'own_{index}', cwd / 'direct-artifact.txt', 'direct test artifact'), fixtures.patch_item(f'source_{index}', source / 'direct-forbidden.txt', 'escape'), {'type': 'message', 'id': f'done_{index}', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': 'Synthetic Tester acceptance complete.'}]}]
            fixture.ready.set()
            command_args = [str(binary), '-C', str(cwd), 'exec', *(['resume'] if session else []), '--skip-git-repo-check', '--json', *([session] if session else []), 'Run synthetic Tester probes.']
            result = subprocess.run(command_args, cwd=cwd, env=env, text=True, capture_output=True, timeout=30)
            (root / f'run-{index}.stdout').write_text(result.stdout)
            (root / f'run-{index}.stderr').write_text(result.stderr)
            require(result.returncode == 0 and not fixture.items and not fixture.failures, f'CLI run {index} failed; inspect fixture {root}')
            events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
            thread = next(event['thread_id'] for event in events if event.get('type') == 'thread.started')
            require(session is None or thread == session, 'Resume created a different native session')
            session = thread
            observed = json.loads((scratch / 'result.json').read_text())
            evidence['runs'].append({'resumed': bool(index), 'thread_id': thread, 'checkout_head_sha': head, 'cwd': str(cwd), 'observed': observed})
            require(observed['source_read'] == 'uncommitted source must remain unchanged\n', 'Original source read failed')
            require(observed['source_write'] == 'EROFS', 'Original source was writable')
            require(observed['checkout_parent_write'] == 'EROFS', 'Tester could write outside its selected subdirectory')
            require(observed['source_secret'] in fixtures.BLOCKED and observed['home_read'] in fixtures.BLOCKED, 'Private file access escaped')
            require(observed['checkout_initial'] == 'committed tester source\n', 'Fresh checkout included previous or uncommitted edits')
            require(observed['previous_artifact'] == 'ENOENT', 'A prior test artifact survived recreation')
            require(observed['checkout_write'] == 'allowed' and observed['scratch_write'] == 'allowed', 'Tester cannot write allowed artifacts')
            require(observed['git_exit'] == 0 and observed['git_head'] == head, 'Tester Git view did not expose the pinned SHA')
            require((cwd / 'direct-artifact.txt').read_text() == 'direct test artifact\n', 'Direct native apply_patch did not create a test artifact')
            require(not (source / 'direct-forbidden.txt').exists() and not (source / 'forbidden.txt').exists(), 'Native tool modified source')
            require((source / 'source.txt').read_text() == 'uncommitted source must remain unchanged\n', 'Original source bytes changed')
            control({'operation': 'close'})
            require(not cwd.exists(), 'Exited Tester checkout was not removed')
        evidence['passed'] = True
    except (AssertionError, OSError, ValueError, subprocess.SubprocessError) as error:
        evidence['passed'] = False; evidence['error'] = str(error)
    finally:
        owner.stdin.close(); owner.wait(timeout=10)
        fixture.close()
        Path(args.report).write_text(json.dumps(evidence, indent=2) + '\n')
        print(json.dumps(evidence, indent=2))
    return 0 if evidence['passed'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
