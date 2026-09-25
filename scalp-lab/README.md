# Scalp Lab

Laboratoire de scalping en **mode replay TradingView**. L'objectif est de tester,
sur des données passées et sans argent réel, si une approche « beaucoup de petits
gains » a une espérance positive **après frais**. Rien ici n'est un conseil
d'investissement.

## Principe

1. Les règles sont écrites **avant** le premier trade dans `rules.json`.
2. Chaque trade est journalisé dans `journal/YYYY-MM-DD.json` (une entrée par trade).
3. `node scalp-lab/stats.js` calcule win rate, ratio gain/perte, espérance nette
   par trade et P&L cumulé. On juge la session sur **l'espérance nette**, pas sur le
   nombre de trades verts.

## Déroulé d'une session (Claude Code en local, TradingView Desktop lancé en CDP)

```
tv_health_check                                   # connexion OK ?
chart_set_symbol   { symbol: rules.instrument }
chart_set_timeframe{ timeframe: rules.timeframe }
replay_start       { date: "2025-06-10" }         # date passée, choisie au hasard
replay_step        # bougie par bougie, lecture de quote_get / data_get_study_values
replay_trade       { action: "buy" | "sell" }     # uniquement si un setup de rules.json est validé
replay_trade       { action: "close" }            # au stop, à l'objectif, ou à la limite de temps
replay_status      # position, P&L courant
```

À chaque trade, Claude écrit l'entrée de journal (voir `journal/example.json`)
**avant** de passer à la bougie suivante.

## Leçons de la session 1 (2025-03-18)

- **Jamais `replay_autoplay` pour rejoindre le début de fenêtre** : il dépasse
  (6 bougies perdues = 30 min). Choisir `replay_start` avec une date/heure juste
  avant `session_window.start`, puis `replay_step` bougie par bougie uniquement.
- **Éviter les dates de roll de contrat** (3e vendredi de mars/juin/sept/déc,
  ± 3 jours) : PDH/PDL deviennent inutilisables et le setup `range_reject` est
  éteint. Préférer des dates en milieu de trimestre.
- Vérifier avec `replay_status` que `current_date` est bien à 09:30 avant le
  premier trade ; sinon, journaliser l'heure réelle de début.

## Garde-fous (non négociables)

- Replay uniquement. Aucun ordre en temps réel.
- Stop placé mentalement à l'entrée et respecté : jamais déplacé contre soi, jamais
  de moyennage à la baisse.
- `max_consecutive_losses` ou `max_daily_loss_ticks` atteint → fin de session, sans
  exception.
- Pas de trade en dehors de la fenêtre `session_window`.
- Un trade sans raison écrite dans le journal ne compte pas : il est marqué
  `"tag": "undisciplined"` et sort des stats.

## Fichiers

| Fichier | Rôle |
|---|---|
| `rules.json` | Instrument, timeframe, stop/objectif, limites journalières, frais |
| `journal/` | Un fichier JSON par session de replay |
| `journal/example.json` | Format d'une entrée de journal |
| `stats.js` | Statistiques nettes de frais sur un ou plusieurs journaux |
