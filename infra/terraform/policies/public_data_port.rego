# METADATA
# title: Porta de dados aberta para a internet
# description: |
#   Security group com entrada de 0.0.0.0/0 ou ::/0 fora das portas web (80 e 443). O check nativo
#   do Trivy (AWS-0107) só cobre portas de administração; banco, Redis e serviços internos ficam
#   restritos a outros security groups (architecture.md §11.2 · §11.3).
# scope: package
# custom:
#   id: CF-0001
#   avd_id: CF-0001
#   provider: aws
#   service: ec2
#   severity: CRITICAL
#   short_code: no-public-data-port
#   recommended_action: Use referenced_security_group_id em vez de um bloco CIDR público.
#   input:
#     selector:
#       - type: cloud
#         subtypes:
#           - service: ec2
#             provider: aws
package user.contrataflow.cf0001

import rego.v1

public_cidrs := {"0.0.0.0/0", "::/0"}

web_ports := {80, 443}

# Regra só de porta web: intervalo de uma porta só, 80 ou 443.
web_only(rule) if {
	rule.fromport.value == rule.toport.value
	rule.fromport.value in web_ports
}

deny contains res if {
	some group in input.aws.ec2.securitygroups
	some rule in group.ingressrules
	some cidr in rule.cidrs
	cidr.value in public_cidrs
	not web_only(rule)
	res := result.new(sprintf("Entrada de %s fora das portas 80/443.", [cidr.value]), cidr)
}
