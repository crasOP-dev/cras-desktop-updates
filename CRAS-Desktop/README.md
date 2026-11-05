# CRAS Desktop

Este repositório público é usado para distribuir atualizações do CRAS Desktop
por meio de GitHub Releases. O aplicativo instalado consulta a versão mais
recente ao iniciar, pede confirmação e substitui somente o executável. Os dados
locais dos computadores não são enviados nem modificados pela atualização.

## Sincronização e perfis

Os registros são sincronizados automaticamente após cada gravação, sem pedir
para escolher entre a versão local e a do outro computador. Alterações em
campos diferentes são combinadas; se o mesmo campo divergir, prevalece Admin,
seguido da Recepção em atendimentos e PAA, do Técnico no Atendimento Técnico
ou da Cadastradora na fila do Cadastro Único.

O último usuário escolhido é lembrado somente neste dispositivo. Perfis comuns
entram automaticamente; o perfil Admin continua exigindo o PIN local.
No Atendimento Técnico, somente a pessoa designada recebe o aviso de ociosidade.
Todas as cadastradoras recebem o aviso do Cadastro Único; a Recepção não recebe
esses avisos. Um Admin pode ser habilitado na Gestão de usuários para também ser
designado como Técnico, mantendo suas permissões administrativas. A Recepção
pode encerrar diretamente qualquer fila, inclusive enquanto ainda aguarda; essa
ação tem prioridade na sincronização com os computadores parceiros.

Para o envio automático funcionar, configure um computador parceiro e o código
de pareamento em Configurações → Sincronização no computador que registra ou
atualiza os dados. Sem um destino configurado, o sistema mantém os dados neste
dispositivo e informa que eles ainda não foram enviados.

## Relatórios

No histórico, monte uma tabela personalizada informando o período, o técnico
e as colunas desejadas. A tabela pode ser recolhida pelo próprio título do
painel e exportada em `.ods`, formato compatível com LibreOffice Calc e Excel.
