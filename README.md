# Atendente M&C Parts (robô do WhatsApp)

Código do Cloudflare Worker **atendente-mcparts**, o atendente virtual da M&C Parts Distribuidora no WhatsApp.

- `src/worker.js`: o robô. Recebe as mensagens (Z-API / Meta / Omni), consulta o estoque pela ponte `ponte-mcparts` (GestaoClick) e responde com o Claude.
- `src/painel.js`: o painel de atendimento em `/painel` (conversas, ligar/desligar o robô, regras e treinos).
- `wrangler.toml`: configuração do worker (banco D1 `painel-mcparts`, KV `MEMORIA`, serviço `PONTE`). Os segredos ficam só no Cloudflare.

## Como as mudanças funcionam

1. Cada correção vira um **PR** (pedido de mudança) neste repositório.
2. O dono revisa o que mudou e aprova (merge).
3. Ao aprovar (merge no `main`), o Cloudflare implanta sozinho: o Workers Builds está ligado a este repositório e roda `npx wrangler deploy` a cada mudança no `main`.

Não edite o código direto no editor do Cloudflare: a próxima implantação pelo GitHub apagaria essa edição.

## Configurações que ficam no banco (não no código)

Tabela `config` do D1 `painel-mcparts`:
- `robo_ligado`: `1` ligado, `0` desligado (a chave do painel).
- `regras`: as regras do atendente editadas no painel.
- `dias_fechados`: feriados e dias sem expediente, no formato `AAAA-MM-DD`, separados por vírgula. Nesses dias o robô trata a loja como fechada.

## Histórico

- 21/11/2026: commit inicial com o código que estava no ar (versão `edd5e813`), já com as correções de feriado (dias fechados, resposta a "estão abertos?" e aviso com o robô desligado).
- 21/11/2026: deploy automático ligado (Workers Builds, branch `main`).
