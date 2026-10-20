#!/bin/sh
SP=${REA_WORKDIR}
F="python3 -I $SP/re/bin/fetch_docs.py"
D=$SP/re/docs
$F "zf4CFrQ4oaR8UN3GV4kT5g" $D/platcap "Configuration Management Database (CMDB)/Explore,CMDB classifications and class dependency,CI relationships in the CMDB,CMDB Identification and Reconciliation (IRE),Dependency Views,CMDB Health,Configuration Management Database (CMDB)/Reference,CSDM,Knowledge Management,Service Catalog,Self-service"
$F "zf4CFrQ4oaR8UN3GV4kT5g" $D/platcap "Configuration Management Database (CMDB)" --max-depth 1
$F "3dXBQFwy2YntRWyGlnrvSA" $D/platadm "User administration,Table admin,Field administration,Form administration,List administration,Time configuration,System notifications,Inbound email,State Management,Metrics,Configure core features/System Events"
$F "Vt_0Y~0Xebp5FL7wfRWefw" $D/crworkflow "Classic approvals,Classic Business rules,Intelligent approvals"
$F "Vt_0Y~0Xebp5FL7wfRWefw" $D/crworkflow "Workflow Studio" --max-depth 2
$F "ooCZhg2g6YDYvKp3oBwAxA" $D/apiref "REST API reference,Web services/REST APIs,Write server-side scripts"
$F "7xQNQY92V5DYmBMD7wXg9g" $D/platux "Lists in the classic environment,Forms in the classic environment,Common UI elements"
$F "7xQNQY92V5DYmBMD7wXg9g" $D/platux "Service Portal,Configurable Workspace UI" --max-depth 2
$F "KI42XRftKnwEsnQ__1vB9g" $D/convint "Virtual Agent" --max-depth 2
$F "UBGwc5glUUjVANqQeiJeZA" $D/platai "Machine learning and natural language capabilities" --max-depth 3
$F "lQvlMH7wms_OXLbvKPDm7g" $D/emplsm "Unified Employee Experience" --max-depth 2
$F "jNwsndxFS5P3jlnmhRxpHw" $D/par "Reporting, dashboards, and Performance Analytics in the Core UI" --max-depth 2
$F "5lCUVazQMuIEd0mJCeBJQA" $D/megaroles "*"
$F "PMOYmdGTPDs40EbYh10h4g" $D/itam "IT Asset Management" --max-depth 2
$F "eH2O6EPUpf09wX0~2cZBFg" $D/itsm "Service Operations Workspace for ITSM,ServiceNow Otto for IT Service Management (ITSM),Walk-up Experience,Simplified IT Service Management" --max-depth 2
$F "eH2O6EPUpf09wX0~2cZBFg" $D/itsm "DevOps Change Velocity" --max-depth 1
echo ALL-DONE
