# CR-039: allow digits in intake names when the scout gives a word split

From: Gavriel, 2026-10-10 12:41 IDT

ets2compliance.com (S6, EU ETS2) was refused at intake with HAS_DIGIT even with words ["ets2","compliance"]. Shomer passed it and its trademark and history records are already in DOM.

Ask: when `words` is given and a token is a known regulation or standard code with a digit (ets2, pfas2, iso27001, nis2, dora2...), accept it at intake and let screening judge it. Keep refusing digits when no words are given.
