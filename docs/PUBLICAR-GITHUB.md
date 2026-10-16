# Publicar o Sussurro no GitHub

Este roteiro publica o **código-fonte** em um repositório público. Ele não instala o aplicativo nem cria uma release com instalador. Os comandos são instruções para você executar; não representam uma publicação já realizada.

## 1. Crie um repositório vazio

Entre na sua conta e abra [Novo repositório](https://github.com/new).

- Nome sugerido: **sussurro**.
- Descrição: **Transcrição do microfone e do áudio do computador para Linux, com Deepgram Nova-3.**
- Visibilidade: **Public**, se quiser que qualquer pessoa possa acessar.
- Não inicialize com README, `.gitignore` ou licença: os arquivos locais serão enviados primeiro.

Copie a URL HTTPS do repositório criado. No exemplo deste guia, substitua `SEU_USUARIO` pelo seu nome no GitHub.

## 2. Confira o que será público

O README da raiz foi preparado para leitores externos. Os documentos de acompanhamento do desenvolvimento continuam na sua pasta local.

| Incluir na primeira publicação | Manter fora da seleção inicial |
| --- | --- |
| README, código, testes, scripts e configurações | `.env`, `.env.local` e qualquer arquivo com chave real |
| `.env.example` com valor vazio | Transcrições, áudios pessoais e dados de sessão |
| `package.json` e `package-lock.json` | `node_modules`, caches e saídas de build |
| Ícones e demais arquivos de `public/` | Modelos e binários locais do Whisper |
| Avisos e licenças de terceiros aplicáveis | Registros internos, capturas e métricas em `docs/evidencias/` |
| Este guia e o marcador vazio da pasta de evidências | Planos e documentos com caminhos pessoais ou contexto interno |

A seleção abaixo é explícita para não incluir a pasta inteira por engano. Ainda assim, revise os arquivos selecionados: isso não substitui uma auditoria de todo o conteúdo. Não use `git add -f` para contornar o `.gitignore`.

O projeto usa **`UNLICENSED`** no `package.json`. Não acrescente um selo de licença MIT ou similar sem definir a licença correspondente.

## 3. Inicie o Git e selecione os arquivos

Abra um terminal **na pasta do Sussurro**. Este fluxo pressupõe que a pasta ainda não seja um repositório Git e que o remoto esteja vazio.

```bash
git init -b main
```

Se o Git pedir sua identidade para o commit, configure o nome e o e-mail desejados **neste repositório**. Você pode usar o endereço de privacidade fornecido nas configurações da sua conta GitHub.

Selecione os arquivos:

```bash
git add README.md .gitignore .env.example package.json package-lock.json
git add index.html tsconfig.json vitest.config.ts vite.main.config.ts vite.preload.config.ts vite.renderer.config.ts forge.config.cjs
git add src public tests scripts
git add docs/PUBLICAR-GITHUB.md docs/evidencias/.gitkeep
git add resources/whisper/LICENSE-* resources/whisper/THIRD-PARTY-NOTICES.txt
```

O arquivo vazio `docs/evidencias/.gitkeep` mantém o diretório usado pelos relatórios dos scripts, sem publicar os relatórios locais existentes. Os scripts legados de preparação Whisper também dependem de artefatos de desenvolvimento que não fazem parte dessa seleção; eles não são necessários ao uso com Deepgram.

Confira a seleção **antes de criar o commit**:

```bash
git status --short
git diff --cached --stat
git diff --cached
```

Revise principalmente chaves reais, transcrições, dados pessoais e arquivos que você não deseja tornar públicos. Para retirar um arquivo da seleção inicial sem apagá-lo do disco:

```bash
git rm --cached -- CAMINHO_DO_ARQUIVO
```

Substitua `CAMINHO_DO_ARQUIVO` pelo arquivo correto. Não acrescente o arquivo novamente antes de resolver a causa.

## 4. Crie o commit e envie

Depois da revisão:

```bash
git commit -m "Apresenta o MVP do Sussurro"
git remote add origin https://github.com/SEU_USUARIO/sussurro.git
git remote -v
git push -u origin main
```

Use o método de autenticação configurado para sua conta. Não coloque tokens na URL do remoto nem nos arquivos do projeto. Se já houver um remoto ou histórico no GitHub, confira a configuração antes de adaptar estes comandos; não use push forçado para resolver diferenças.

Esse é o passo que efetivamente envia o conteúdo selecionado ao GitHub. A documentação oficial explica o [envio de um projeto local para o GitHub](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github?platform=linux).

## 5. Confira a apresentação

Abra o repositório no navegador e confira:

- A imagem do Sussurro aparece no topo do README.
- As instruções e os links funcionam.
- Os arquivos de configuração com chaves reais não aparecem.
- A descrição e os tópicos do repositório correspondem ao projeto. Sugestões: `linux`, `electron`, `react`, `typescript`, `transcription`, `deepgram`.
- O texto não anuncia um instalador disponível antes de existir uma versão validada para distribuição.

Se quiser distribuir um instalador depois, publique-o em **Releases**, junto de instruções e checksum, quando o empacotamento estiver concluído. Não é necessário colocar binários de build no histórico Git para publicar o código.

---

Voltar para o [README do Sussurro](../README.md).
