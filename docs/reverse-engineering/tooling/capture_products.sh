#!/bin/sh
SP=${REA_WORKDIR}
C=$SP/re/bin/capture.sh
$C p01-incident-management https://www.servicenow.com/products/incident-management.html 6000
$C p02-problem-management https://www.servicenow.com/products/problem-management.html 6000
$C p03-change-management https://www.servicenow.com/products/change-management.html 6000
$C p04-request-management https://www.servicenow.com/products/request-management.html 6000
$C p05-knowledge-management https://www.servicenow.com/products/knowledge-management.html 6000
$C p06-cmdb https://www.servicenow.com/products/servicenow-platform/configuration-management-database.html 6000
$C p07-employee-center https://www.servicenow.com/products/employee-center.html 6000
$C p08-virtual-agent https://www.servicenow.com/products/virtual-agent.html 6000
$C p09-predictive-intelligence https://www.servicenow.com/products/predictive-intelligence.html 6000
$C p10-it-service-desk https://www.servicenow.com/products/it-service-desk.html 6000
$C p11-itsm-get-started https://www.servicenow.com/products/itsm/get-started.html 6000
$C p12-devops-change-velocity https://www.servicenow.com/products/devops-change-velocity.html 6000
$C p13-asset-management https://www.servicenow.com/products/asset-management-core.html 6000
$C p14-otto https://www.servicenow.com/platform/otto.html 6000
echo CAPTURES-DONE
