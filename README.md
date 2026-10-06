# wa

Cliente WhatsApp em modo terminal, inspirado no [wechit](https://github.com/LingDong-/wechit). Liga-se como
"dispositivo associado" através da biblioteca [baileys](https://github.com/WhiskeySockets/Baileys), guarda tudo em
SQLite local e desenha a interface com painéis, rato e imagens no próprio terminal.

## Arrancar

```sh
npm install
./wa            # ou: npm start
./wa ema        # abre logo a conversa cujo nome ou número contém "ema"
```

Na primeira vez aparece um código QR: no telemóvel, WhatsApp › Definições › Dispositivos associados › Associar
dispositivo. A sessão fica guardada e nas vezes seguintes liga directamente.

Enquanto se usa o terminal o cliente anuncia-se "disponível" ao WhatsApp, por isso o telemóvel não notifica, tal
como com o WhatsApp Web aberto. Ao fim de 2 minutos parado volta a "indisponível".

Requisitos: Node 22.13 ou mais recente (usa o SQLite embutido no Node).

## Interface

Mensagens a toda a largura, a escrita em baixo com o prompt `>`, e no fundo a barra de tabs com o estado da ligação
à direita. Sem molduras nem fundos próprios: as cores são as do tema do terminal, e no arranque pergunta-se ao
terminal a cor real do fundo para escolher tons claros ou escuros.

- **Tabs**: um por conversa aberta, com as não lidas a vermelho e um `×` para fechar. Tab circula pelos abertos;
  o que ficou por enviar fica guardado em cada conversa. Enquanto alguém escreve, um arco-íris corre pelo nome.
  Mensagens novas numa conversa sem tab abrem-no sem o activar, com um aviso passageiro sobre ele e a campainha.
- **Conversas**: `/` abre a lista, com as mais recentes em baixo e um excerto da última mensagem; o que se escreve
  filtra, sem acentos nem maiúsculas; Enter ou clique abrem.
- **Mensagens**: as tuas à direita. Roda do rato ou PgUp/PgDn. Clique num anexo abre-o com `xdg-open`,
  descarregando-o se preciso. Clique ou ↑ selecciona uma mensagem: escrever responde-lhe, `:` reage, Delete abre
  uma tua para a corrigir. Arrastar uma mensagem para a direita, ou → com ela seleccionada, também começa a resposta.
- **Escrita**: cresce com o texto até metade do ecrã; Enter envia, Shift+Enter ou Ctrl+J começam uma linha nova e
  colar várias linhas mantém-nas. Ctrl-U limpa, Shift-Backspace apaga a palavra (com o protocolo de teclado do
  Kitty). `:` e duas letras abrem a lista de emojis; ↑/↓, Enter, Tab, → ou um clique escolhem.
- Esc fecha, por ordem: o filtro, a lista, o tab activo. Fechar o último tab sai. Ctrl-C sai logo.
- **Vários terminais**: o primeiro processo é o servidor com a ligação ao WhatsApp; os seguintes ligam-se a ele por um
  socket e são só interface, cada um com os seus tabs. Se o servidor terminar, outro assume a ligação.
- **Conversa única**: `wa <nome>` abre só essa conversa, sem barra de tabs nem avisos das outras; a lista `/` troca-a.
  Um coração ou um beijo sozinhos, em mensagem ou reacção, fazem subir pelo painel um coração ou uns lábios da cor
  do emoji, desenhados em blocos.

### Herdr

Dentro do [Herdr](https://herdr.dev) o `wa` arranca em conversa única e cada conversa é um tab dele: escolher uma na
lista abre um tab novo (ou foca o que já a tem), e uma mensagem de uma conversa sem tab abre um em segundo plano. O
título do tab segue a conversa, com `●` quando há por ler, e o `wa` aparece na lista de agentes do Herdr: `working`
enquanto a pessoa escreve, `blocked` com mensagens por ler, `idle` caso contrário. Fora do Herdr, o título da janela
do terminal faz o mesmo.

### Formatação e emojis

A marcação do WhatsApp é mostrada com atributos do terminal: `*negrito*`, `_itálico_`, `~riscado~`, `` `código` ``,
`> citação`. Ao enviar, escreve-se a marcação tal como no telemóvel. Códigos `:nome:` são trocados pelo emoji ao
fechar o segundo `:`, com nomes em português e em inglês (`:fixe:` 👍, `:beijinho:` 😘, `:bica:` ☕ …; lista em
`src/emoji.ts`), e os smileys clássicos isolados por espaços também (`:)`, `;)`, `<3` …).

### Imagens

No arranque o cliente pergunta ao terminal o que sabe fazer, sem assumir nada pelo `TERM`. Em terminais com o
protocolo gráfico do Kitty (Ghostty, Kitty, WezTerm, Konsole) as imagens, stickers e miniaturas aparecem a sério no
painel; nos restantes são desenhadas com meios-blocos coloridos. `WA_IMAGES=kitty|blocks|none` força o modo.

## Sugestões de escrita

Com um `llama-server` local em `http://127.0.0.1:8080` (ou `WA_LLM`), modelo `gemma4-26b` (ou `WA_LLM_MODEL`), a
escrita pede uma sugestão pouco depois da última tecla, com as últimas mensagens como contexto: as letras que faltam à
palavra a meio, coladas ao cursor, ou a palavra certa a seguir a `⇢`, seja a palavra a meio corrigida ou um erro mais
atrás (ortografia, acentos, palavras coladas, expressão ou gramática). Tab ou → aceitam; várias setas seguidas aceitam
as correcções em cadeia. `WA_LLM=off` desliga.

## Dados

Tudo em `~/.config/wa` (ou `WA_HOME`):

| Caminho | Conteúdo |
|---|---|
| `auth/` | Credenciais da sessão (apagar para associar de novo) |
| `wa.db` | SQLite com conversas, contactos, mensagens e reacções |
| `media/<conversa>/` | Anexos descarregados e miniaturas |
| `wa.log` | Log (nível com `WA_LOG=info|debug`) |

O histórico começa com o que o WhatsApp envia aos dispositivos novos. `WA_FULL_HISTORY=1` pede o histórico completo
na associação.

## Estrutura

| Ficheiro | Papel |
|---|---|
| `src/wa.ts` | Ligação ao WhatsApp: QR, reconexão, mensagens, reacções, envio, anexos |
| `src/ipc.ts` | Servidor e cliente por socket Unix, para vários processos partilharem uma ligação |
| `src/db.ts` | Esquema e consultas SQLite (`node:sqlite`) |
| `src/ui.ts` | Interface blessed: painéis, teclado, rato, desenho das mensagens |
| `src/format.ts` | Marcação do WhatsApp, datas, cores, quebra de linhas |
| `src/image.ts` | Descodificação, meios-blocos, protocolo gráfico do Kitty |
| `src/term.ts` | Sondagem das capacidades do terminal |
| `src/kittykeys.ts`, `src/paste.ts` | Protocolo de teclado do Kitty e colagem com parênteses, lidos antes do blessed |
| `src/herdr.ts` | Estado de agente, títulos e tabs no Herdr |
| `src/hearts.ts` | Animação do coração e do beijo |
| `src/llm.ts` | Sugestões de escrita pelo `llama-server` local |
| `src/emoji.ts`, `src/italic.ts`, `src/rainbow.ts` | Tabela `:nome:`, itálico no blessed, cores |
