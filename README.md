# wa

Cliente WhatsApp em modo terminal, inspirado no [wechit](https://github.com/LingDong-/wechit). Liga-se como
"dispositivo associado" através da biblioteca [baileys](https://github.com/WhiskeySockets/Baileys), guarda tudo em
SQLite local e desenha a interface com painéis, rato e imagens no próprio terminal.

## Arrancar

```sh
npm install
./wa            # ou: npm start
```

Na primeira vez aparece um código QR: no telemóvel, WhatsApp › Definições › Dispositivos associados › Associar
dispositivo. A sessão fica guardada e nas vezes seguintes liga directamente.

Requisitos: Node 22.13 ou mais recente (usa o SQLite embutido no Node). Testado com Node 26.

## Interface

Mensagens a toda a largura, duas linhas de escrita com o prompt `>`, e no fundo a barra de tabs, com o estado da
ligação e os avisos encostados à direita. Sem molduras nem fundos próprios: tudo no fundo por omissão do terminal,
e o tab activo marcado só pelo texto, a negrito e na cor mais forte do tema.

As cores são as do tema do terminal: fundo e texto por omissão em todos os painéis, e os realces nas 16 cores
nomeadas (vermelho, amarelo…), que o tema já garante legíveis; só o texto secundário (horas, legendas, citações) usa
um cinzento da rampa de 256 com contraste garantido, porque o cinzento do tema costuma ser quase invisível sobre
fundo escuro. No arranque o cliente pergunta ao terminal a cor real do fundo (OSC 11) para saber se o tema é escuro
ou claro: os nomes e o texto secundário usam tons claros ou escuros conforme o caso, o tab activo fica branco vivo
ou preto, e a mensagem seleccionada ganha um fundo cinzento afastado do fundo real. Se o terminal não responder,
assume-se escuro e o cinzento da selecção é médio.

- **Tabs**: um por conversa aberta, com o número de não lidas a vermelho e um `×` para fechar. Clique no nome activa,
  clique no `×` fecha. Tab circula pelos tabs abertos sem lhes mexer na ordem; é ao começar a escrever que o tab
  activo passa para a primeira posição, junto da escrita, ficando os outros pela ordem em que estavam. `/` ou Ctrl-T
  abrem as "conversas". Com as "conversas" abertas nenhum tab fica realçado. Mensagens novas numa conversa sem tab abrem um tab no fim,
  sem o activar nem reordenar os outros. Os tabs abertos e o activo ficam guardados e voltam no arranque seguinte.
- **Conversas**: a lista de conversas, com as mais recentes em baixo, mostrando o nome, as não lidas, um `·`
  nas que já têm tab e um excerto da última mensagem. O que se escreve vai para a linha do prompt, que passa a `/`,
  e filtra a lista, sem acentos nem maiúsculas; setas, Enter ou clique abrem a conversa num tab e activam-no; Esc
  limpa o filtro e depois fecha a lista.
- **Mensagens**: as tuas à direita, as dos outros à esquerda. Roda do rato, PgUp/PgDn. Clique num anexo
  (imagem, vídeo, ficheiro, áudio) abre-o com `xdg-open`; se ainda não estiver descarregado, descarrega-o.
  Um clique numa mensagem, ou ↑ a partir da escrita, selecciona-a; ↑/↓ movem a selecção e ↓ da última volta à
  escrita, tal como Esc. Sobre a seleccionada, basta escrever para responder (a escrita ganha uma linha com a
  citação; Enter envia, Esc desiste) e `:` reage: o `:` fica já escrito, completa-se o `:fixe:` ou escreve-se o emoji directo, e
  Enter envia; Enter com a linha vazia retira a reacção.
  As reacções de todos aparecem numa linha cinzenta por baixo da mensagem.
- **Escrita**: duas linhas, texto partido por palavras; Enter envia. Setas, Home e End movem o cursor, e um clique
  põe-no onde se clicou; Backspace e Delete apagam para trás e para a frente, Ctrl-U limpa a linha e Shift-Backspace
  apaga a palavra anterior (só em terminais com o protocolo de teclado do Kitty: Kitty, Ghostty, foot, WezTerm). O mesmo
  vale para o filtro das "conversas". Clique num painel activa-o; `i` no painel de mensagens volta à escrita.
- Esc fecha, por ordem: o filtro do escolhedor, o escolhedor, o tab activo. Fechar o último tab leva às "conversas"; Esc aí, sem tabs abertos, sai do programa. Ctrl-C sai logo.
- Mensagens novas noutra conversa fazem soar a campainha do terminal e aparecem à direita na barra de tabs; abrir ou activar
  o tab marca-as como lidas.
- **Vários terminais**: podes abrir o `wa` em quantos terminais quiseres. O primeiro processo é o servidor, com a
  ligação ao WhatsApp, e abre um socket em `$XDG_RUNTIME_DIR/wa-<id>.sock`; os seguintes ligam-se a ele e são só
  interface, cada um com os seus tabs, guardados por terminal. Uma conversa com tab num terminal não abre tab noutro, e
  uma mensagem nova numa conversa sem tab abre-o só no terminal usado mais recentemente. Se o servidor terminar, um
  dos outros assume a ligação sozinho.

### Comandos na linha de escrita

| Comando | Efeito |
|---|---|
| `/` | Abre o escolhedor de conversas; o que se escreve a seguir filtra a lista |

### Formatação e emojis

A marcação do WhatsApp é mostrada com atributos do terminal: `*negrito*` a negrito, `_itálico_` sublinhado (o
blessed não sabe itálico), `~riscado~` a cinzento, `` `código` `` e blocos a amarelo, linhas `> citação` a cinzento,
endereços a azul. Ao enviar, escreve-se a marcação tal como no telemóvel.

Códigos `:nome:` na linha de escrita são trocados por emojis assim que se fecha o segundo `:`, com nomes em português de Portugal, sem
acentos, e em inglês: `:fixe:` ou `:thumbsup:` 👍, `:gargalhada:` 😂, `:beijinho:` 😘, `:coracao:` ❤️, `:fogo:` 🔥,
`:certo:` ✅, `:bica:` ☕, `:imperial:` 🍺, `:galo:` 🐓, `:autocarro:` 🚌, `:telemovel:` 📱, `:portugal:` 🇵🇹 … A lista
completa está em `src/emoji.ts`. Os smileys clássicos também são convertidos quando isolados por espaços: `:)` 🙂,
`:-D` 😃, `:(` 🙁, `;)` 😉, `:P` 😛, `:*` 😘, `:O` 😮, `:'(` 😢, `:/` 😕, `<3` ❤️, `xD` 😆, `B)` 😎 … Um `:/` dentro de
`http://` fica intacto. Emojis escritos directamente pelo teclado também funcionam.

### Imagens

- No arranque o cliente pergunta ao terminal o que sabe fazer (`src/term.ts`), em três fases: primeiro a versão
  (XTVERSION, uma sequência CSI que qualquer terminal ignora se não conhecer) e um pedido de identificação; a quem
  responder pergunta as cores por omissão do texto e do fundo (OSC 10 e 11); e só a quem se identificar como Ghostty,
  Kitty, WezTerm ou Konsole manda depois a consulta do protocolo gráfico, e só usa o que o terminal confirmar. Nada é
  assumido pelo `TERM`.
- Em terminais que respondem ao protocolo gráfico do Kitty (Ghostty, Kitty, WezTerm, Konsole) as imagens, stickers
  e miniaturas de vídeo aparecem a sério dentro do painel de mensagens.
- Nos restantes são desenhadas com meios-blocos `▀` coloridos (256 cores).
- As molduras usam caracteres de caixa Unicode quando a localização (`LANG`, `LC_ALL`) é UTF-8; senão fica o conjunto
  de linhas do terminfo.
- `WA_IMAGES=kitty|blocks|none` força o modo das imagens.

## Dados

Tudo em `~/.config/wa` (ou `WA_HOME`):

| Caminho | Conteúdo |
|---|---|
| `auth/` | Credenciais da sessão (apagar para associar de novo) |
| `wa.db` | SQLite com `chats`, `contacts`, `lids` e `messages` (texto, estado, caminho do anexo, mensagem crua em JSON) |
| `media/<conversa>/` | Anexos descarregados e miniaturas |
| `wa.log` | Log (nível com `WA_LOG=info|debug`) |

O histórico começa no primeiro arranque com o que o WhatsApp envia aos dispositivos novos (as conversas recentes).
`WA_FULL_HISTORY=1` pede o histórico completo na associação; demora e ocupa mais espaço.

## Estrutura

| Ficheiro | Papel |
|---|---|
| `src/wa.ts` | Ligação ao WhatsApp: QR, reconexão, tradução das mensagens do baileys para a base de dados, envio, anexos |
| `src/ipc.ts` | Servidor e cliente por socket Unix, para vários processos partilharem uma ligação |
| `src/backend.ts` | O que a interface pede a quem fala com o WhatsApp, local ou remoto |
| `src/db.ts` | Esquema e consultas SQLite (`node:sqlite`) |
| `src/ui.ts` | Interface blessed: painéis, teclado, rato, desenho das mensagens, colocação das imagens Kitty |
| `src/format.ts` | Marcação do WhatsApp para etiquetas do blessed, datas, cores por remetente |
| `src/image.ts` | Descodificação com jimp, meios-blocos, protocolo gráfico do Kitty |
| `src/term.ts` | Sondagem das capacidades do terminal antes de arrancar a interface |
| `src/emoji.ts` | Tabela de códigos `:nome:` |
