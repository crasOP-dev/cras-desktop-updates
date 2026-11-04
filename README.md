# CRAS Desktop Updates

Este repositório publica atualizações do CRAS Desktop por meio de GitHub
Releases. O código e os arquivos necessários para compilar o aplicativo estão
em `CRAS-Desktop/`.

Para publicar uma versão, envie uma tag no formato `vMAJOR.MINOR.PATCH`, por
exemplo `v1.0.0`. O GitHub Actions executa os testes, compila o executável
Windows e publica o executável e seu checksum na Release.

Os computadores consultam Releases públicas ao iniciar. O aplicativo pede
confirmação antes de atualizar e preserva os dados locais.
