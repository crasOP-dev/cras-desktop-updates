# CRAS Desktop Updates

Este repositório publica atualizações do CRAS Desktop por meio de GitHub
Releases. O código e os arquivos necessários para compilar o aplicativo estão
em `CRAS-Desktop/`.

Para publicar uma versão, envie uma tag no formato `vMAJOR.MINOR.PATCH`, por
exemplo `v1.0.0`. O GitHub Actions executa os testes, compila o executável
Windows e publica o executável e seu checksum na Release.

Os computadores consultam Releases públicas ao iniciar. O aplicativo pede
confirmação antes de atualizar e preserva os dados locais.

## Arquitetura de dados

O notebook servidor executa o CRAS Desktop e mantém o SQLite central. Os demais
postos encontram o servidor automaticamente via mDNS, autenticam a sincronização
com a senha individual e guardam uma cópia local para operação offline da
Recepção. A sincronização é retomada quando a conexão retorna; a interface móvel
pode ser instalada como PWA no Android e no iOS e usa uma cópia local após o
primeiro acesso.

As instruções de configuração, migração inicial do computador Principal e uso
offline estão em [`CRAS-Desktop/README.md`](./CRAS-Desktop/README.md).
