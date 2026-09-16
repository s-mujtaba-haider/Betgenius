## **Primary Success Target: Pass at Least 8 of 11 Markets**

The primary MLB Phase 1 objective is to produce **at least 8 validated winning markets out of the 11 MLB markets**, with more than 8 considered a stronger result.

The 11 markets are:

1. `batter_hits`  
2. `batter_rbis`  
3. `totals`  
4. `spreads`  
5. `batter_total_bases`  
6. `batter_home_runs`  
7. `pitcher_strikeouts`  
8. `h2h`  
9. `runs_scored`  
10. `pitcher_outs`  
11. `batter_strikeouts`

### **Target**

| Target | Requirement |
| ----- | ----- |
| Minimum passing markets | **8 / 11** |
| Stretch target | **9–11 / 11** |
| Point-in-time integrity | Mandatory |
| Out-of-sample validation | Mandatory |
| Existing client gate | Mandatory |
| Real-row production verification | Mandatory |
| Failed markets | Must be investigated and documented |
| Forced/overfit passes | Not acceptable |

The objective is **not** to manipulate the gate until 8 markets pass.

Instead, the project should use progressively stronger and more market-appropriate modeling techniques to maximize the number of genuinely validated markets.

---

## **Market Improvement Strategy**

Every market that initially fails the gate enters an **improvement loop**.

### **Improvement Loop**

Initial Market  
      ↓  
Data Quality Audit  
      ↓  
Point-in-Time / Leakage Audit  
      ↓  
Baseline Model  
      ↓  
Walk-Forward Validation  
      ↓  
Calibration  
      ↓  
Existing Gate  
      ↓  
PASS ───────────────→ Production  
      │  
      ↓ FAIL  
Market Failure Analysis  
      ↓  
Feature Engineering  
      ↓  
Alternative Statistical Model  
      ↓  
Alternative ML Model  
      ↓  
Ensemble / Hybrid Model  
      ↓  
Calibration / Probability Improvement  
      ↓  
Market-Specific Threshold Optimization  
      ↓  
Walk-Forward Revalidation  
      ↓  
Existing Gate  
      │  
      ├── PASS → Production  
      │  
      └── FAIL → Try next appropriate technique  
                         ↓  
                   Final VETO / FAIL

A market should only be marked permanently failed after reasonable modeling approaches have been evaluated.

---

# **Market-Specific Modeling Strategy**

There must not be an assumption that one model architecture will work for all 11 markets.

Each market should have its own modeling strategy based on the statistical nature of the target.

## **1\. `batter_hits`**

Target:

Number of hits by batter

Initial approaches:

* Poisson regression  
* Negative Binomial regression  
* Logistic model for `0 vs 1+`  
* LightGBM  
* CatBoost  
* XGBoost

Useful features:

* Batter recent hit rate  
* Season hit rate  
* At-bats/game  
* Plate appearances  
* Opposing pitcher  
* Pitcher handedness  
* Batter handedness  
* Batter vs pitcher history where sample size is sufficient  
* Ballpark  
* Home/away  
* Expected lineup position  
* Recent form  
* Opposing team pitching strength  
* Bullpen strength  
* Expected game total  
* Weather when available before prediction time

Consider a **two-stage model**:

P(1+ hit)  
      \+  
Expected number of hits  
      ↓  
Final probability distribution

---

## **2\. `batter_rbis`**

RBIs are highly dependent on opportunities.

Model:

P(RBI)

should account for:

* Batting order  
* Expected plate appearances  
* Teammate OBP  
* Runners-on-base opportunities  
* Team implied runs  
* Batter power  
* Batter recent production  
* Opposing pitcher  
* Bullpen  
* Park  
* Game total

Potential approaches:

* Logistic regression  
* CatBoost  
* LightGBM  
* Zero-inflated Poisson  
* Negative Binomial  
* Two-stage opportunity \+ conversion model

A useful decomposition is:

Expected RBI opportunities  
              ×  
Probability of converting opportunity  
              ↓  
Expected RBI

---

## **3\. `totals`**

Target:

Combined runs

Candidate approaches:

* Poisson  
* Negative Binomial  
* Generalized Poisson  
* Gradient boosting  
* Team run models  
* Ensemble of statistical \+ ML models

Model:

Home expected runs  
Away expected runs  
        ↓  
Combined run distribution  
        ↓  
P(Over)  
P(Under)

Important features:

* Starting pitchers  
* Bullpens  
* Team offensive strength  
* Park factor  
* Weather  
* Temperature  
* Wind  
* Batting lineup  
* Recent team performance  
* Implied team totals  
* Market total  
* Rest/travel where available

---

## **4\. `spreads`**

Model the expected run differential:

Home Runs \- Away Runs

Potential approaches:

* Linear regression  
* Ridge/Lasso  
* Gradient boosting  
* CatBoost  
* Distributional run-difference model  
* Ensemble

Useful features:

* Starting pitcher difference  
* Offensive strength difference  
* Bullpen difference  
* Park  
* Home advantage  
* Team form  
* Lineup strength  
* Market spread  
* Market total

---

## **5\. `batter_total_bases`**

This is a highly distributional player-performance market.

Instead of directly predicting the final line, model:

P(0 TB)  
P(1 TB)  
P(2 TB)  
P(3 TB)  
P(4+ TB)

Potential approaches:

* Poisson  
* Negative Binomial  
* Gradient boosting  
* CatBoost  
* Two-stage hit \+ extra-base model  
* Ensemble

Break the problem into:

At-bats  
   ↓  
P(hit)  
   ↓  
Hit type distribution  
   ↓  
Total bases distribution

This can be more informative than treating total bases as a simple regression target.

---

## **6\. `batter_home_runs`**

Home runs are rare-event predictions.

Avoid relying only on generic regression.

Evaluate:

* Logistic regression  
* Poisson  
* Negative Binomial  
* Zero-inflated models  
* CatBoost  
* LightGBM  
* XGBoost  
* Ensemble

Features:

* Batter HR rate  
* Barrel rate  
* Hard-hit rate  
* Fly-ball rate  
* Exit velocity  
* Launch angle  
* Pitcher HR allowed  
* Pitch type matchup  
* Park HR factor  
* Handedness matchup  
* Expected plate appearances  
* Weather  
* Wind  
* Game total

Because this is a rare-event market, **calibration and sample size are especially important**.

---

## **7\. `pitcher_strikeouts`**

Model:

Expected strikeouts  
\+  
Probability of clearing line

Features:

* Pitcher K rate  
* Batter K rates  
* Expected batters faced  
* Pitch count  
* Recent pitch counts  
* Opponent strikeout rate  
* Pitcher pitch mix  
* Handedness  
* Umpire where available before prediction  
* Expected innings  
* Team offense  
* Game context

Potential models:

* Poisson  
* Negative Binomial  
* LightGBM  
* CatBoost  
* XGBoost  
* Ensemble

Potential decomposition:

Expected innings  
        ×  
Expected batters faced per inning  
        ×  
Strikeout probability  
        ↓  
Strikeout distribution

---

## **8\. `h2h`**

Binary classification:

Team A wins  
vs  
Team B wins

Candidate models:

* Logistic regression  
* Elo-style model  
* Bradley-Terry  
* Gradient boosting  
* CatBoost  
* XGBoost  
* Ensemble

Features:

* Starting pitcher  
* Bullpen  
* Offensive strength  
* Defensive strength  
* Home advantage  
* Lineup  
* Team form  
* Park  
* Rest  
* Market information available at prediction time

Probability calibration is particularly important.

---

## **9\. `runs_scored`**

This market should model individual team run production.

Potential approaches:

* Poisson  
* Negative Binomial  
* Zero-inflated models  
* Gradient boosting  
* CatBoost  
* LightGBM  
* Ensemble

Features:

* Team offensive strength  
* Starting pitcher  
* Bullpen  
* Park  
* Weather  
* Lineup  
* Batting order  
* Recent performance  
* Opponent defense/pitching  
* Market-implied team total

---

## **10\. `pitcher_outs`**

This is primarily an **opportunity / workload** problem.

Model:

Expected innings/outs

Features:

* Recent pitch counts  
* Recent innings  
* Season workload  
* Manager usage  
* Starting pitcher status  
* Expected game competitiveness  
* Opponent offense  
* Pitcher efficiency  
* Walk rate  
* Strikeout rate  
* Contact rate  
* Injury/availability information available before prediction  
* Expected pitch count

Potential approaches:

* Regression  
* Gradient boosting  
* CatBoost  
* LightGBM  
* Quantile regression  
* Distributional modeling

A useful approach is:

P(remaining in game)  
\+  
Expected outs conditional on remaining

---

## **11\. `batter_strikeouts`**

Potential approaches:

* Logistic regression  
* Poisson  
* Negative Binomial  
* LightGBM  
* CatBoost  
* XGBoost  
* Ensemble

Features:

* Batter K rate  
* Opposing pitcher K rate  
* Pitcher pitch mix  
* Batter handedness  
* Pitcher handedness  
* Expected plate appearances  
* Recent form  
* Opposing bullpen  
* Umpire  
* Expected lineup position

Again, model the underlying opportunity:

Expected plate appearances  
        ↓  
Strikeout probability per PA  
        ↓  
Strikeout distribution

---

# **Failure Does Not Mean Immediate Veto**

If a market fails the first model, the workflow should be:

### **Level 1 — Data Investigation**

Check:

* Missing data  
* Incorrect joins  
* Incorrect player/team IDs  
* Incorrect odds mapping  
* Incorrect market grading  
* Incorrect timestamps  
* Duplicate games  
* Duplicate odds  
* Incorrect lines  
* Incorrect result grading

### **Level 2 — Leakage Investigation**

Verify:

* No future game results  
* No future player statistics  
* No closing odds when prediction occurred earlier  
* No future lineup information  
* No future weather  
* No future injury information  
* Rolling features exclude the current game  
* All features existed at prediction time

### **Level 3 — Feature Engineering**

Try additional **point-in-time-valid** features.

Examples:

Recent form  
Season-to-date form  
Opponent strength  
Player/team matchup  
Park effects  
Weather  
Lineup position  
Expected opportunity  
Market-derived features  
Pitcher/batter matchup  
Bullpen state

### **Level 4 — Alternative Model**

Do not assume the baseline model is optimal.

Evaluate appropriate alternatives such as:

Logistic Regression  
Poisson  
Negative Binomial  
Zero-Inflated Poisson  
Ridge/Lasso  
LightGBM  
XGBoost  
CatBoost  
Elo  
Bradley-Terry  
Quantile Regression  
Hierarchical Models  
Distributional Models

### **Level 5 — Ensemble**

Where individual models have complementary strengths:

Statistical Model  
        \+  
ML Model  
        \+  
Market Information  
        ↓  
Ensemble Probability

The ensemble must itself be evaluated using strict walk-forward validation.

### **Level 6 — Calibration**

If discrimination is acceptable but probabilities are poorly calibrated, evaluate:

* Platt scaling  
* Isotonic regression  
* Beta calibration

Calibration must be trained only on historical training/validation periods and evaluated out-of-sample.

### **Level 7 — Market-Specific Thresholds**

Different markets can legitimately require different minimum:

* Edge  
* EV  
* Confidence  
* Sample size  
* Calibration quality  
* Stability

Thresholds should be selected using training/validation periods and then tested on untouched future data.

---

# **Market Improvement Log**

Every market should maintain an experiment record.

Example:

Market: batter\_home\_runs

Attempt 1:  
Model: Logistic Regression  
Result: FAIL

Attempt 2:  
Model: CatBoost  
Result: FAIL

Attempt 3:  
Model: Negative Binomial  
Result: PASS

Attempt 4:  
Model: CatBoost \+ Negative Binomial Ensemble  
Result: PASS

Selected Model:  
CatBoost \+ Negative Binomial Ensemble

Reason:  
Improved out-of-sample calibration and EV stability.

Validation:  
Walk-forward

Production:  
ENABLED

This makes the final result auditable instead of simply showing a final model.

---

# **Market Status System**

Each market should ultimately receive one of:

PASS  
PASS\_WITH\_RESTRICTIONS  
FAIL\_AFTER\_ITERATION  
VETO

Example:

| Market | Initial | Iterations | Final |
| ----- | ----- | ----- | ----- |
| batter\_hits | FAIL | 4 | PASS |
| batter\_rbis | FAIL | 5 | PASS |
| totals | PASS | 1 | PASS |
| spreads | FAIL | 3 | PASS |
| batter\_total\_bases | FAIL | 5 | PASS |
| batter\_home\_runs | FAIL | 6 | VETO |
| pitcher\_strikeouts | PASS | 2 | PASS |
| h2h | PASS | 1 | PASS |
| runs\_scored | FAIL | 4 | PASS |
| pitcher\_outs | FAIL | 5 | PASS |
| batter\_strikeouts | FAIL | 3 | PASS |

The example above is only an illustration of the workflow; the actual statuses must come from the validated experiments.

---

# **Optimization Rule**

The project should optimize:

MAXIMIZE

Number of genuinely validated MLB markets

SUBJECT TO

\- Point-in-time integrity  
\- No leakage  
\- Out-of-sample validation  
\- Calibration  
\- Existing client gate  
\- Minimum sample requirements  
\- Robustness  
\- Production reliability

The minimum target is:

PASS \>= 8 / 11

The preferred outcome is:

PASS \> 8 / 11

However:

"8 passes" is not achieved by weakening the gate.

It is achieved by finding better data, features, models, probability estimation, calibration, and market-specific modeling where those improvements are supported by out-of-sample evidence.

---

# **Final MLB Optimization Loop**

The entire MLB Phase 1 process should therefore operate as:

             MLB Historical Data  
                     ↓  
              Data Quality Audit  
                     ↓  
          Point-in-Time Validation  
                     ↓  
             Market Construction  
                     ↓  
          Baseline Models (11)  
                     ↓  
          Walk-Forward Validation  
                     ↓  
               Calibration  
                     ↓  
             Existing Gate  
                     ↓  
             ┌───────┴───────┐  
             ↓               ↓  
           PASS             FAIL  
             ↓               ↓  
       Production      Failure Analysis  
                             ↓  
                     Feature Engineering  
                             ↓  
                    Alternative Models  
                             ↓  
                       Ensembles  
                             ↓  
                        Calibration  
                             ↓  
                  Market-Specific Tuning  
                             ↓  
                  Walk-Forward Validation  
                             ↓  
                       Existing Gate  
                             ↓  
                  ┌──────────┴──────────┐  
                  ↓                     ↓  
                PASS              Still FAIL  
                  ↓                     ↓  
             Production          Next Technique  
                                        ↓  
                                  Final VETO

The final objective is to have **8 or more of the 11 MLB markets genuinely validated and production-ready**, while every remaining market has a documented technical explanation for why it did not meet the required standard and what specific improvement would be required to revisit it.