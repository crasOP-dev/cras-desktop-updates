# CRAS Desktop

Este repositório público é usado para distribuir atualizações do CRAS Desktop
por meio de GitHub Releases. O aplicativo instalado consulta a versão mais
recente ao iniciar, pede confirmação e substitui somente o executável. Os dados
locais dos computadores não são enviados nem modificados pela atualização.

## Sincronização e perfis

Os registros são sincronizados automaticamente após cada gravação, sem pedir
para escolher entre a versão local e a do outro computador. Alterações em
campos diferentes são combinadas; se o mesmo campo divergir, prevalece Admin,
seguido da Recepção/Estagiário em atendimentos e PAA, do Técnico no Atendimento
Técnico ou da Cadastradora na fila do Cadastro Único.

O último usuário escolhido é lembrado somente neste dispositivo. Perfis comuns
entram automaticamente; o perfil Admin continua exigindo o PIN local.
No Atendimento Técnico, somente a pessoa designada recebe o aviso de ociosidade.
Todas as cadastradoras recebem o aviso do Cadastro Único; a Recepção e o
Estagiário não recebem esses avisos. Um Admin pode ser habilitado na Gestão de
usuários para também ser designado como Técnico, mantendo suas permissões
administrativas. A Recepção e o Estagiário podem encerrar diretamente qualquer
fila, inclusive enquanto ainda aguarda; essa ação tem prioridade na sincronização
com os computadores parceiros. Quando a Recepção finaliza uma fila atribuída,
a pessoa designada recebe a pergunta de confirmação; sem responsável designado,
a pergunta não é exibida.

O perfil Estagiário tem as mesmas ações operacionais da Recepção no computador.
No celular, o sistema completo continua disponível, mas a tela inicial destaca
a fila do Atendimento Técnico. O Estagiário pode adquirir uma pasta sem iniciar
o atendimento; a fila mostra quem a retirou e quando. Ele pode devolver a
própria pasta à fila.

Para usar o celular, mantenha o CRAS Desktop aberto no computador e conecte os
dois à mesma rede Wi-Fi privada e confiável. Um Admin deve configurar um código
móvel de pelo menos 12 caracteres em **Usuários → Acesso pelo celular**. Nas
Configurações do computador, baixe o certificado raiz pelo endereço informado,
confira sua impressão digital e instale-o como certificado confiável em cada
celular autorizado. Depois, abra no celular um dos endereços HTTPS exibidos,
informe o código e selecione o usuário. As alterações da fila são sincronizadas
com o computador; o celular atualiza a tela periodicamente. Não use essa função
em Wi-Fi público nem exponha as portas do aplicativo à Internet. Se o endereço
não abrir, confirme que os dois dispositivos estão na mesma rede Wi-Fi (não em
uma rede de convidados) e permita o CRAS Desktop na rede privada do Firewall do
Windows. O servidor móvel usa a porta TCP 8766; instalar a CA valida o
certificado, mas não libera a conexão através do firewall.

Para iniciar a rede P2P, conecte cada computador a pelo menos um parceiro
confiável usando o endereço IPv4 e o código de pareamento desse parceiro. Na
primeira conexão, os computadores trocam, dentro do pacote P2P criptografado, os
endereços e códigos de pareamento já conhecidos; assim, os demais parceiros
são adicionados sem recadastrar cada PC. Use somente PCs da rede privada
autorizada: um parceiro confiável passa a conhecer os códigos dos demais
parceiros. O Principal é o primeiro ponto de coordenação; filas e histórico
continuam replicados nos PCs vinculados, preservando o uso offline. Em
**Configurações → Sincronização**, os endereços deste PC incluem todos os IPv4
ativos, inclusive os fixos configurados nas interfaces do Windows.

## Chat e backups

A aba **Chat** está disponível no CRAS Desktop. Mensagens, emojis e imagens/GIFs
(PNG, JPG, GIF ou WebP, até 2 MB) são enviados aos computadores parceiros
configurados. Uma recomendação pode ser vinculada a um atendimento existente;
o chat mostra o nome e somente os dois últimos dígitos do CPF para ajudar a
identificar a pessoa. A referência não altera a fila. Cada PC arquiva, antes de
limpar, as mensagens dos meses anteriores em
`%LOCALAPPDATA%\CRAS-Desktop\chat-backups`. Esses arquivos compactados permanecem
no próprio computador até serem removidos manualmente.

No computador principal, um Admin deve ativar **Este é o PC Principal (backup
diário)** nas Configurações. O CRAS cria backups compactados diários do
histórico, encaminhamentos, usuários e dados do PAA em
`%LOCALAPPDATA%\CRAS-Desktop\backups`, mantendo os 30 mais recentes. O arquivo
`.json.gz` pode ser selecionado diretamente em **Exportação → Importar backup**;
o conteúdo é mesclado aos registros locais. Códigos de pareamento não são
incluídos nesses backups.

O histórico continua completo e independente do preenchimento automático do
formulário. A tabela mostra 50 registros por página; filtros e exportação
continuam consultando o histórico inteiro.

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
podem precisar instalar essa primeira versão corrigida manualmente.

Também é possível atualizar manualmente: coloque o executável oficial
`CRAS-Desktop.exe` na mesma pasta do aplicativo atual e abra o arquivo baixado.
Ele substitui o executável antigo com segurança, inicia a nova versão como
`CRAS Desktop.exe` e mantém os dados locais.
