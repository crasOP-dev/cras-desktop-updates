# CRAS Desktop

Este repositório público é usado para distribuir atualizações do CRAS Desktop
por meio de GitHub Releases. O aplicativo instalado consulta a versão mais
recente ao iniciar, pede confirmação e substitui somente o executável. Os dados
locais dos computadores não são enviados nem modificados pela atualização.

## Sincronização e perfis

Os registros são sincronizados automaticamente após cada gravação com o
servidor central, sem pedir para escolher entre a cópia local e a do servidor.
Alterações em campos diferentes são combinadas; se o mesmo campo divergir,
prevalece Admin, seguido da Recepção/Estagiário em atendimentos e PAA, do
Técnico no Atendimento Técnico ou da Cadastradora na fila do Cadastro Único.
Para evitar perda de campos que uma versão antiga desconhece, todos os
dispositivos precisam estar na mesma versão; clientes sem versão compatível
são recusados com uma mensagem para atualizar.
Se a sincronização automática não localizar o servidor central ou faltar a
credencial individual do usuário, o aplicativo agora informa o motivo no
status de sincronização e em **Configurações → Servidor central**. Confirme
também que os computadores estão na mesma rede local e que o servidor central
está ativo.

Cada usuário cria uma senha individual no primeiro acesso (mínimo de 8
caracteres); o sistema guarda apenas um hash com salt e sincroniza a credencial
com a lista de usuários. O primeiro cadastro é feito pela própria pessoa ao
selecionar o nome, sem validação externa de identidade: em um computador
compartilhado, alguém poderia cadastrar a senha no lugar de outra pessoa.
Confirme a identidade durante o primeiro acesso.
O hash individual também autentica as solicitações de sincronização e chat ao
servidor central; o código compartilhado de pareamento não é mais utilizado.
Se um PC pedir uma senha que já existe no servidor, informe a senha já
cadastrada. Se a tela estiver no modo de criação, escolha **Já tenho senha no
servidor**; só use **Primeiro acesso? Criar senha neste PC** quando o usuário
ainda não tiver senha no servidor. Se o PC entrar automaticamente, acesse
**Configurações → Trocar usuário** para abrir a tela de login. A recuperação
valida a senha no servidor e restaura a credencial local sem alterar a senha
central.

Na tela de entrada, marque **Lembrar este usuário e pular o login neste
dispositivo** para abrir automaticamente essa conta nos próximos inícios. Isso
também se aplica ao Admin; use somente em um dispositivo de acesso controlado.
Desmarque a opção ou troque de usuário para encerrar esse acesso automático.
No Atendimento Técnico, somente a pessoa designada recebe o aviso de ociosidade.
Todas as cadastradoras recebem o aviso do Cadastro Único; a Recepção e o
Estagiário não recebem esses avisos. Um Admin pode ser habilitado na Gestão de
usuários para também ser designado como Técnico, mantendo suas permissões
administrativas. A Recepção e o Estagiário podem encerrar diretamente qualquer
fila, inclusive enquanto ainda aguarda; essa ação tem prioridade na sincronização
com o servidor central. Quando a Recepção finaliza uma fila atribuída,
a pessoa designada recebe a pergunta de confirmação; sem responsável designado,
a pergunta não é exibida.

O perfil Estagiário tem as mesmas ações operacionais da Recepção no computador.
No celular, o sistema completo continua disponível, mas a tela inicial destaca
a fila do Atendimento Técnico. O Estagiário pode adquirir uma pasta sem iniciar
o atendimento; a fila mostra quem a retirou e quando. Ele pode devolver a
própria pasta à fila.

O chat também está disponível no celular em tela cheia, com avisos gerais,
conversas individuais, histórico paginado, emojis, imagens/GIFs e vínculo de
pessoa à recomendação. As mensagens são consultadas e enviadas pelo servidor
central usando a conexão móvel HTTPS.
Após a primeira validação, o código móvel não é salvo: uma chave criptográfica
não exportável é guardada no armazenamento local do navegador para reconhecer
aquele celular nas próximas aberturas. Bloqueie o aparelho e não compartilhe o
perfil do navegador. Limpar os dados do navegador ou trocar/desativar o código
exigirá uma nova validação; o login individual do usuário continua separado.

## Servidor central e operação offline

Execute o CRAS Desktop no notebook que será o servidor central, entre como
Admin e ative **Este computador é o servidor central** em
**Configurações → Sincronização**. Mantenha-o ligado e aberto. O SQLite desse
computador guarda o estado central; os outros desktops o localizam
automaticamente por mDNS na rede local, sem configurar endereço IP ou código
compartilhado. Se mDNS não estiver disponível, o aplicativo também tenta
localizar o servidor na rede local. Mantenha somente um computador ativado
como servidor central.
Não exponha as portas 8765 e 8766 à Internet. Uma rede cabeada Ethernet
funciona sem Wi‑Fi.

Os postos mantêm uma cópia local para que a Recepção continue registrando e
operando filas quando não houver nenhuma rede. As gravações locais são enviadas
ao servidor quando a conexão retorna; os conflitos são mesclados pelas regras
de prioridade por perfil já existentes. Os outros postos podem aguardar o
servidor. Para localizar o servidor, os dispositivos devem estar na mesma rede
local; políticas de rede podem bloquear mDNS e a descoberta automática.

### Primeira migração do computador Principal

Atualize o CRAS Desktop em todos os computadores e ative o servidor central no
notebook. No computador Principal atual, aguarde a descoberta automática e a
conclusão da sincronização antes de abrir os demais postos. Essa primeira
sincronização mescla o conteúdo do Principal ao SQLite do servidor; ela não
apaga os dados locais. Cada usuário deve entrar e criar ou validar sua senha
individual em cada posto. Ative o backup diário no notebook servidor e confira
os arquivos em
`%LOCALAPPDATA%\CRAS-Desktop\backups`.

### Celulares Android e iOS

Um Admin configura um código móvel de pelo menos 12 caracteres em
**Usuários → Acesso pelo celular**. Na primeira conexão, acesse um dos endereços
HTTPS exibidos quando o servidor central está ativo. Os QR codes usam o endereço
IPv4 local atual do servidor para evitar falhas de resolução do nome `.local`
em alguns celulares; se a rede do computador mudar, leia o QR atualizado.
Primeiro, escaneie o QR do certificado CA, confira a impressão digital e
instale-o como confiável. Depois, escaneie o QR do CRAS para abrir diretamente
o aplicativo HTTPS. No
iPhone, faça os dois passos no Safari; após instalar o perfil em Ajustes, ative
a confiança total em Ajustes → Geral → Sobre → Ajustes de Confiança do
Certificado. Permita o acesso à rede local se o iOS solicitar. Para instalar o
atalho, use Compartilhar → **Adicionar à Tela de Início**. Após carregar e
autenticar uma vez, a aplicação e os dados ficam disponíveis offline naquele
dispositivo; alterações feitas offline são sincronizadas quando o servidor
volta.

Celulares precisam de Wi‑Fi ou outra conexão para a primeira instalação e para
sincronizar; sem qualquer rede, só podem usar a cópia offline previamente
carregada. Não use Wi‑Fi público nem exponha as portas 8765 e 8766 à Internet.
Se o endereço não abrir, conecte os dispositivos à mesma rede privada e permita
o CRAS Desktop nas regras de rede privada do Firewall do Windows. Instalar a CA
valida o certificado, mas não libera a conexão no firewall.

## Chat e backups

O botão **Chat** abre a equipe. Na lista lateral, escolha **Avisos gerais** para
enviar a todos ou selecione uma pessoa para abrir a conversa individual. O
histórico e os anexos individuais ficam visíveis somente aos dois participantes.
Enter envia a mensagem; Shift+Enter cria uma nova linha. Mensagens, emojis e
imagens/GIFs (PNG, JPG, GIF ou WebP, até 2 MB) são enviados ao servidor central. Uma
recomendação pode ser vinculada a um atendimento existente; o chat mostra o
nome e somente os dois últimos dígitos do CPF para ajudar a identificar a
pessoa. A referência não altera a fila. Se o servidor estiver indisponível, a
mensagem fica na fila local de reenvio. Antes da limpeza mensal, cada PC arquiva
as mensagens antigas em
`%LOCALAPPDATA%\CRAS-Desktop\chat-backups`. Esses arquivos compactados
permanecem no próprio computador até serem removidos manualmente.

No computador principal, um Admin deve ativar **Este é o PC Principal (backup
diário)** nas Configurações. O CRAS cria backups compactados diários do
histórico, encaminhamentos, usuários e dados do PAA em
`%LOCALAPPDATA%\CRAS-Desktop\backups`, mantendo os 30 mais recentes. O arquivo
`.json.gz` pode ser selecionado diretamente em **Exportação → Importar backup**;
o conteúdo é mesclado aos registros locais. As contas incluem hashes de senha
com salt; proteja os backups adequadamente.

O histórico continua completo e independente do preenchimento automático do
formulário. Cada encaminhamento é exibido em uma linha própria; **Excluir
encaminhamento** remove somente aquela fila, enquanto **Excluir atendimento**
remove o registro inteiro. A tabela mostra 50 registros por página; filtros e
exportação continuam consultando o histórico inteiro.

No CRAS Desktop, o envio dos registros do PAA ao Google Sheets é configurado
separadamente: em **Configurações → Sincronização**, informe o URL publicado do
Apps Script e o token de acesso, e conecte. O URL fica salvo nas configurações;
o token é validado e mantido apenas enquanto o aplicativo estiver aberto. Depois,
use **Enviar pendentes ao Google** na aba PAA. Novos registros e alterações
também são enviados automaticamente enquanto houver conexão ativa.

## Relatórios

No histórico, monte uma tabela personalizada informando o período, o técnico
e as colunas desejadas. A tabela pode ser recolhida pelo próprio título do
painel e exportada em `.ods`, formato compatível com LibreOffice Calc e Excel.

## Atualizações

O atualizador verifica o GitHub ao abrir o executável e valida os downloads
com SHA-256. Só oferece uma versão publicada mais nova que a instalada e pede
confirmação antes de baixar e instalar. A conexão HTTPS usa o repositório de
certificados confiáveis do Windows para respeitar certificados corporativos
instalados no sistema. Se a troca do executável falhar, consulte
`%LOCALAPPDATA%\CRAS-Desktop\update.log`. A correção do instalador precisa ser
publicada em uma nova release; computadores cuja atualização anterior falhou
podem precisar instalar essa primeira versão corrigida manualmente: feche o
aplicativo, substitua o executável existente pelo arquivo oficial mantendo o
nome e a pasta, e então abra-o novamente. O aplicativo não copia nem renomeia
mais a si próprio durante a inicialização.
