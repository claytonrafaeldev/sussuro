<div align="center">
  <img src="public/icon.png" alt="Ícone do Sussurro: ondas de áudio em verde-limão" width="96" height="96" />
  <h1>Sussurro</h1>
  <p><strong>Sua voz e o áudio do computador, em texto.</strong></p>
  <p>Aplicativo desktop para Linux com transcrição por streaming, fontes independentes e salvamento local.</p>
  <p><strong>Linux amd64 · Deepgram Nova-3 · Português e inglês · MVP 0.1.0</strong></p>
  <p>
    <a href="#começar">Começar</a> ·
    <a href="#como-usar">Como usar</a> ·
    <a href="#privacidade-e-custos">Privacidade</a> ·
    <a href="#desenvolvimento">Desenvolvimento</a> ·
    <a href="docs/PUBLICAR-GITHUB.md">Publicar no GitHub</a>
  </p>
</div>

---

## O que o Sussurro faz

Transcreva o microfone, o som do computador ou os dois ao mesmo tempo. Acompanhe o texto na janela principal ou em um pequeno popup, pause quando precisar e guarde o resultado em TXT.

| Recurso | Como funciona |
| --- | --- |
| Duas fontes de áudio | Microfone e saída do computador com seletores e controles independentes. |
| Texto durante a fala | Resultados parciais são atualizados e substituídos pelos trechos confirmados. |
| Idioma original | Português, inglês e seleção multilíngue; sem tradução. |
| Salvamento automático | Escolha um TXT antes de começar e salve os trechos confirmados durante a sessão. |
| Sem histórico | Mantenha a transcrição na janela e salve manualmente apenas se quiser. |
| Histórico local | Reabra sessões salvas, copie o texto, exporte TXT ou remova registros. |
| Popup de acompanhamento | Veja as últimas palavras, pause e volte ao aplicativo. |
| Interface escura | Marca verde-limão, cantos retos e navegação por páginas para textos longos. |

> **Versão em desenvolvimento.** Ainda não há instalador `.deb` validado para distribuição. As instruções abaixo executam o aplicativo a partir do código-fonte. O reconhecimento usa internet e uma chave própria do Deepgram.

## Começar

### Requisitos

- **Linux amd64** com sessão gráfica e áudio funcionando. O MVP foi usado em Ubuntu com PipeWire; outras distribuições ainda precisam de validação.
- **Node.js 24** e **npm**, para executar a partir do código-fonte.
- **Internet, conta no Deepgram e uma API key** com acesso ao serviço e créditos disponíveis.
- **Microfone e permissão de uso**, para transcrever sua voz.
- **PipeWire, `pw-dump` e `pw-record`**, para listar e capturar a saída de áudio do computador. Os utilitários costumam fazer parte de `pipewire-bin`, conforme a distribuição.

O projeto não instala serviços de áudio, drivers ou dependências globais automaticamente.

### Executar o aplicativo

Clone o repositório e abra a pasta do projeto:

```bash
git clone https://github.com/claytonrafaeldev/sussuro.git sussurro
cd sussurro
```

Instale as dependências e inicie o aplicativo:

```bash
npm ci
npm run dev
```

O primeiro comando instala as dependências locais pelo lockfile. O segundo inicia o ambiente de desenvolvimento e abre a janela Electron. É necessário acesso à rede para baixar as dependências e o runtime do Electron na primeira instalação.

**Use a janela do aplicativo.** Abrir apenas o endereço do Vite no navegador não oferece a ponte desktop necessária para transcrever.

### Configurar a chave

Na janela principal, clique em **Configurar API key**, informe sua chave do Deepgram e confirme. Quando houver um backend seguro disponível no sistema, a interface permite persistir a chave protegida. Sem esse backend, a chave fica somente em memória, com aviso.

Para desenvolvimento, você também pode usar um arquivo local:

```bash
cp -n .env.example .env.local
chmod 600 .env.local
```

Abra `.env.local` no seu editor e preencha **somente a cópia**:

```dotenv
DEEPGRAM_API_KEY=sua_chave_aqui
```

Reinicie o aplicativo depois de editar. Não use prefixo `VITE_` e não coloque a chave no código, em screenshots ou em mensagens públicas.

A ordem de leitura é: **ambiente do processo principal → `.env.local` → `.env` → configuração protegida**, quando aplicável. Nos arquivos de desenvolvimento, uma chave definida como vazia impede o fallback entre essas fontes. Esses arquivos guardam texto puro, são ignorados pelo Git e não são lidos pelo aplicativo instalado. Remover a chave pela interface não altera seu `.env.local` nem o ambiente do terminal.

## Como usar

### 1. Escolha as fontes

Em **Fontes de áudio**, habilite o **Microfone**, o **Áudio do computador** ou ambos. Selecione o dispositivo desejado em cada campo.

Para o som do computador, escolha a saída que está reproduzindo o áudio. Se você trocar de dispositivo ou conectar um fone, use **Atualizar** e confira a seleção.

### 2. Escolha o idioma e o destino

Em **Idioma do áudio**, selecione o idioma que será falado. Use **Multilíngue** quando precisar alternar idiomas na mesma sessão.

Em **Destino da transcrição**, escolha:

| Modo | Resultado |
| --- | --- |
| **Salvar transcrição** | Ao iniciar, escolha onde salvar o TXT. O texto confirmado é salvo automaticamente durante a transcrição, ao pausar, finalizar e fechar. A sessão também fica no histórico local. |
| **Sem histórico** | O texto fica somente na janela. Não há salvamento automático nem registro no histórico; use **Copiar** ou **Exportar TXT** para guardar o resultado. |

### 3. Inicie e acompanhe

Clique em **Iniciar transcrição**, no cabeçalho do painel de transcrição. A captura começa após a preparação das fontes; abrir o aplicativo sozinho não inicia gravação.

As barras mostram o nível de cada fonte. Os trechos indicam se vieram do microfone ou do computador, e o texto parcial pode mudar até ser confirmado. Duração, áudio pendente, lacunas e atraso ajudam a acompanhar a sessão.

Textos longos usam **Anterior**, **Próxima** e **Últimos trechos**. A cópia e a exportação incluem a sessão completa, além da página visível.

### 4. Pause ou finalize

- **Pausar captura** interrompe a captura e o envio de áudio. Use **Retomar captura** para continuar.
- **Desativar uma fonte** libera aquela captura; a outra pode continuar habilitada.
- **Finalizar** encerra a sessão e aguarda os resultados finais dentro do prazo de encerramento.
- **Cancelar pendências** descarta o áudio ainda não transcrito e preserva o texto já confirmado.

### 5. Copie, exporte ou reabra

Use **Copiar** para levar o texto à área de transferência ou **Exportar TXT** para escolher um arquivo.

O botão **Histórico** abre uma lista rolável das sessões salvas cujo TXT ainda existe. **Excluir** remove o registro interno e mantém o TXT no disco. Se você apagar o TXT por fora do aplicativo, a sessão deixa de aparecer nessa lista.

### Popup de acompanhamento

Ao iniciar a captura, um popup semitransparente é solicitado no canto superior direito do monitor da janela principal. Ele mostra o estado da sessão, a duração e as últimas palavras.

- Arraste pelo cabeçalho para reposicionar.
- Use **Pausar** para interromper a captura; o popup passa a mostrar **Pausado**.
- Use **Abrir Sussurro** para restaurar a janela principal e retomar ou finalizar por lá.
- Finalização, erro ou saída fecham o popup.

O popup reutiliza a sessão existente: não abre outro microfone nem outra conexão com o provedor. Sua sobreposição e posição ainda precisam de validação no desktop. No **Wayland**, o Electron não suporta `alwaysOnTop`, portanto a permanência acima das outras janelas não é garantida. [Documentação do Electron](https://www.electronjs.org/docs/latest/api/browser-window/).

## Privacidade e custos

**O áudio é processado na nuvem pelo Deepgram.** Apenas as fontes habilitadas são enviadas durante uma captura iniciada por você. Pausar, desligar uma fonte ou encerrar a sessão interrompe o envio correspondente.

- Não há login próprio do Sussurro; a conta e a cobrança do Deepgram são separadas.
- Microfone e áudio do computador usam fluxos independentes. Duas fontes ativas podem consumir créditos separadamente.
- O projeto não persiste áudio bruto por padrão. No modo salvo, os textos ficam no histórico local e no TXT escolhido.
- A chave é gerenciada no processo principal e não é devolvida à interface nem incluída no histórico.
- O modo **Sem histórico** evita o salvamento automático local; o áudio continua sendo enviado ao provedor durante a captura.

Consulte os [preços do Deepgram](https://deepgram.com/pricing) e as condições da sua conta antes de usar. Precisão e atraso variam conforme áudio, idioma, conexão e disponibilidade do serviço.

## Desenvolvimento

Stack: **Electron · React · TypeScript · Vite · Electron Forge · Vitest**.

```text
src/main/       Janelas, captura Linux, streaming, IPC e persistência
src/preload/    Ponte limitada entre Electron e interface
src/renderer/   Interface, captura do microfone e popup
src/shared/     Contratos e validação de dados
public/         Ícones e AudioWorklet
scripts/        Verificações e diagnósticos
tests/         Testes de lógica e integração simulada
```

| Comando | Finalidade |
| --- | --- |
| `npm run dev` | Iniciar o aplicativo em desenvolvimento. |
| `npm run typecheck` | Verificar os tipos TypeScript. |
| `npm test` | Executar os testes automatizados. |
| `npm run build:bundles` | Compilar main, preload e renderer em área temporária, sem instalador. |
| `npm run validate` | Encadear typecheck, testes e compilação dos bundles. |
| `npm run recovery:test` | Verificar cenários de recuperação com dados sintéticos. |
| `npm run audio:test` | Diagnosticar o monitor de áudio com um tom de teste, após confirmação no terminal. |
| `npm run popup:test` | Tentar validar o formulário de chave em Electron com dados sintéticos; não testa o popup de transcrição. |
| `npm run build` | Tentar gerar a pasta do aplicativo Linux com Forge; não gera `.deb`. |

Typecheck, testes focais e compilação já foram executados no desenvolvimento. Testes simulados e build não comprovam captura real, comportamento do compositor ou funcionamento do chaveiro. A execução de diagnósticos que usam áudio público no Deepgram é separada e pode consumir créditos; nenhum deles é necessário para abrir o aplicativo.

O código legado do Whisper está preservado, mas não é o motor principal. Não é necessário baixar seu modelo para usar o fluxo Deepgram.

## Solução de problemas

| Situação | O que conferir |
| --- | --- |
| “A ponte desktop não está disponível” | Use a janela Electron iniciada por `npm run dev`, não a prévia no navegador. |
| Nenhuma saída de áudio aparece | Confira se PipeWire, `pw-dump` e `pw-record` estão disponíveis na sessão do seu usuário; depois clique em **Atualizar**. |
| Microfone sem sinal | Confira dispositivo, permissões e volume de entrada no sistema. |
| O inglês não é reconhecido como esperado | Selecione **Inglês** ou **Multilíngue** antes de iniciar. |
| Chave ausente, recusada ou sem créditos | Confira a configuração no aplicativo e a situação da conta no provedor. |
| Conexão interrompida ou fonte indisponível | Corrija a origem do erro e retome explicitamente. O aplicativo não reinicia a captura sozinho. |
| Falha ao salvar | Confira pasta e permissões; copie ou exporte o texto antes de fechar. |
| Popup não fica acima de outra janela | Pode ser uma limitação do Wayland ou do compositor. |
| Electron não abre por sandbox/permissão | Execute como usuário comum e confira os requisitos do Electron na distribuição. Não desative o sandbox como solução. |
| A porta local de desenvolvimento está ocupada | Encerre a outra instância de desenvolvimento antes de iniciar novamente. |

## Estado e distribuição

O MVP tem funcionamento de transcrição em português e inglês relatado no ambiente de desenvolvimento, com fontes independentes e salvamento local. A validação em outras distribuições, ensaios prolongados e o popup nativo ainda têm limites.

Não há instalador público validado, suporte Windows/macOS, funcionamento offline, tradução ou garantia de latência constante nesta versão.

Quer publicar seu próprio repositório? Siga o [guia de publicação no GitHub](docs/PUBLICAR-GITHUB.md).

## Licença

O projeto está identificado como **`UNLICENSED`** no `package.json` e ainda não contém uma licença própria de distribuição. As licenças dos componentes de terceiros permanecem junto aos respectivos componentes. Uma licença para o Sussurro deve ser definida pelo responsável antes de anunciar permissões de reutilização.
