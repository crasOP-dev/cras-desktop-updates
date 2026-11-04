# CRAS Desktop

Este repositório público é usado para distribuir atualizações do CRAS Desktop
por meio de GitHub Releases. O aplicativo instalado consulta a versão mais
recente ao iniciar, pede confirmação e substitui somente o executável. Os dados
locais dos computadores não são enviados nem modificados pela atualização.

## Sincronização e perfis

Os registros são sincronizados automaticamente após cada gravação, sem pedir
para escolher entre a versão local e a do outro computador. Alterações em
campos diferentes são combinadas; se o mesmo campo divergir, prevalece Admin,
seguido da Recepção em atendimentos e PAA, da Assistente na fila de Assistência
ou da Cadastradora na fila do Cadastro Único.

O último usuário escolhido é lembrado somente neste dispositivo. Perfis comuns
entram automaticamente; o perfil Admin continua exigindo o PIN local.

Para o envio automático funcionar, configure um computador parceiro e o código
de pareamento em Configurações → Sincronização no computador que registra ou
atualiza os dados. Sem um destino configurado, o sistema mantém os dados neste
dispositivo e informa que eles ainda não foram enviados.
