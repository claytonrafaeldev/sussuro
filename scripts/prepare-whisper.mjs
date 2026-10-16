import { readFile, writeFile, mkdir, copyFile, chmod, access, stat, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const external = path.resolve(root, '../whisper-hardware-check');
const archive = option('--archive', path.join(external, 'whisper-v1.8.2.tar.gz'));
const model = option('--model', path.join(external, 'ggml-base.bin'));
const cmake = option('--cmake', path.join(external, 'cmake-3.31.6-linux-x86_64/bin/cmake'));
const runtime = path.join(root, 'resources/whisper');
const cache = path.join(root, '.cache/whisper');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (file, argv) => new Promise((resolve, reject) => {
  const child = spawn(file, argv, { cwd: root, stdio: 'inherit', shell: false });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${file}: código ${code}`)));
});

try {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Preparação suportada em Linux amd64.');
  const manifest = JSON.parse(await readFile(path.join(root, 'docs/evidencias/modelo-base.json'), 'utf8'));
  await access(cmake);
  const archiveBytes = await readFile(archive);
  const sourceHash = 'bcee25589bb8052d9e155369f6759a05729a2022d2a8085c1aa4345108523077';
  if (sha(archiveBytes) !== sourceHash) throw new Error('Arquivo-fonte v1.8.2 não corresponde ao SHA-256 fixado.');
  const modelBytes = await readFile(model);
  if (modelBytes.length !== manifest.bytes || sha(modelBytes) !== manifest.sha256_observed) throw new Error('Modelo inválido: selecione ggml-base.bin multilíngue com o hash esperado.');
  await mkdir(cache, { recursive: true });
  let previous;
  const previousCpp = path.join(cache, 'whisper.cpp-1.8.2/examples/server/server.cpp');
  try { previous = { bytes: await readFile(previousCpp, 'utf8'), meta: await stat(previousCpp) }; } catch {}
  await run('tar', ['-xzf', path.resolve(archive), '-C', cache]);
  const source = path.join(cache, 'whisper.cpp-1.8.2');
  const serverPath = path.join(source, 'examples/server/server.cpp');
  let cpp = await readFile(serverPath, 'utf8');
  const anchor = '    std::atomic<server_state> state{SERVER_STATE_LOADING_MODEL};';
  if (!cpp.includes(anchor)) throw new Error('Código do servidor inesperado; patch recusado.');
  // Limit the upstream demo server to the two operations owned by the app.
  cpp = '#include <cstdlib>\n' + cpp.replace(anchor, `${anchor}
    const char * raw_token = std::getenv("SUSSURRO_WHISPER_TOKEN");
    if (!raw_token || std::string(raw_token).size() < 32) return 4;
    const std::string expected_auth = std::string("Bearer ") + raw_token;
    svr->set_payload_max_length(2 * 1024 * 1024);
    svr->set_pre_routing_handler([expected_auth](const Request & req, Response & res) {
        if (req.has_header("Origin") || req.get_header_value("Authorization") != expected_auth) {
            res.status = 403; return httplib::Server::HandlerResponse::Handled;
        }
        if (!((req.method == "GET" && req.path == "/health") ||
              (req.method == "POST" && req.path == "/inference"))) {
            res.status = 404; return httplib::Server::HandlerResponse::Handled;
        }
        return httplib::Server::HandlerResponse::Unhandled;
    });`);
  cpp = cpp.replace('else if (res.status != 500)', 'else if (res.status != 500 && res.status != 403 && res.status != 413)');
  cpp = cpp.replace('{"Access-Control-Allow-Origin", "*"}', '{"Cache-Control", "no-store"}');
  cpp = cpp.replace('get_req_parameters(req, params);', 'get_req_parameters(req, params);\n        params.translate = false; params.print_realtime = false; params.print_progress = false;');
  await writeFile(serverPath, cpp);
  if (previous?.bytes === cpp) await utimes(serverPath, previous.meta.atime, previous.meta.mtime);
  const build = path.join(cache, 'build');
  const flags = ['-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_BACKEND_DL=OFF', '-DGGML_NATIVE=OFF', '-DGGML_AVX=ON', '-DGGML_AVX2=OFF', '-DGGML_FMA=OFF', '-DGGML_BMI2=OFF', '-DGGML_F16C=ON', '-DGGML_OPENMP=OFF', '-DGGML_CUDA=OFF', '-DGGML_VULKAN=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=ON'];
  await run('nice', ['-n', '15', cmake, '-S', source, '-B', build, ...flags]);
  await run('nice', ['-n', '15', cmake, '--build', build, '--target', 'whisper-server', '-j', '1']);
  await mkdir(path.join(runtime, 'bin'), { recursive: true });
  await mkdir(path.join(runtime, 'models'), { recursive: true });
  const binary = path.join(runtime, 'bin/whisper-server');
  await copyFile(path.join(build, 'bin/whisper-server'), binary);
  await chmod(binary, 0o755);
  await copyFile(model, path.join(runtime, 'models/ggml-base.bin'));
  await copyFile(path.join(source, 'LICENSE'), path.join(runtime, 'LICENSE-whisper.cpp'));
  await copyFile(path.join(source, 'LICENSE'), path.join(runtime, 'LICENSE-ggml'));
  const mit = await readFile(path.join(source, 'LICENSE'), 'utf8');
  for (const [file, copyright] of [['LICENSE-model', 'Copyright (c) 2022 OpenAI'], ['LICENSE-httplib', 'Copyright (c) 2025 Yuji Hirose'], ['LICENSE-json', 'Copyright (c) 2013-2022 Niels Lohmann']]) await writeFile(path.join(runtime, file), mit.replace(/Copyright[^\n]*/, copyright));
  await writeFile(path.join(runtime, 'THIRD-PARTY-NOTICES.txt'), 'whisper.cpp / ggml: MIT, Georgi Gerganov and contributors; see LICENSE-whisper.cpp.\ncpp-httplib: MIT, Copyright (c) 2025 Yuji Hirose.\nnlohmann/json: MIT, Copyright (c) 2013-2022 Niels Lohmann.\nFull vendored source and license headers are in the pinned source archive.\n');
  await copyFile(path.join(source, 'samples/jfk.wav'), path.join(cache, 'jfk.wav'));
  const record = {
    version: '1.8.2', platform: 'linux-x64', sourceUrl: 'https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.8.2.tar.gz',
    sourceSha256: sourceHash, patchSha256: sha(Buffer.from(cpp)), binarySha256: sha(await readFile(binary)),
    modelSha256: manifest.sha256_observed, modelBytes: manifest.bytes, modelUrl: manifest.download_url,
    flags, auth: 'environment token + bearer; Origin rejected; health/inference only; loopback required by launcher',
  };
  await writeFile(path.join(runtime, 'manifest.json'), JSON.stringify(record, null, 2) + '\n');
  console.log('Runtime Whisper e modelo base preparados. Nenhum servidor foi iniciado.');
} catch (error) {
  console.error(`Preparação interrompida: ${error.message}`);
  process.exitCode = 1;
}
