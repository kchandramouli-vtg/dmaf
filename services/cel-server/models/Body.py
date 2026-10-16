import xml.etree.ElementTree as ET
from typing import Dict, List

from pydantic.main import BaseModel

from models.DeonticStructuredBlock import DeonticStructuredBlock
from models.DeonticStructuredClause import DeonticStructuredClause
from bindings import party_addresses


class Body(BaseModel):
    data: str
    namespace: Dict[str, str]
    textualPart: List[str] = []
    operativePart: List[str] = []
    type: List[str] = []

    def parse(self):
        body = ET.fromstring(self.data)
        self.data = None
        textClauses = body.findall(
            "cel-core:TextualPart/cel-core:TextualPart:TextClause", self.namespace
        )
        for text in textClauses:
            self.textualPart.append(ET.tostring(text))
        deonticStructuredBlocks = body.findall(
            "cel-core:OperativePart/cel-core:DeonticStructuredBlock", self.namespace
        )
        if deonticStructuredBlocks:
            for block in deonticStructuredBlocks:
                deonticStructuredBlock = DeonticStructuredBlock(
                    **{"data": ET.tostring(block), "namespace": self.namespace}
                )
                deonticStructuredBlock.parse()
                self.operativePart.append(deonticStructuredBlock)

        statement = body.findall(
            "cel-core:OperativePart/cel-core:Statement", self.namespace
        )
        if statement:
            for clause in statement:
                statement_part = DeonticStructuredClause(
                    **{"data": ET.tostring(clause), "namespace": self.namespace}
                )
                statement_part.parse()
                self.operativePart.append(statement_part)
                self.type.append("Statement")

        permission = body.findall(
            "cel-core:OperativePart/cel-ipre:Permission", self.namespace
        )
        if permission:
            for clause in permission:
                permission_part = DeonticStructuredClause(
                    **{"data": ET.tostring(clause), "namespace": self.namespace}
                )
                permission_part.parse()
                self.operativePart.append(permission_part)
                self.type.append("Permission")

        obligation = body.findall(
            "cel-core:OperativePart/cel-core:Obligation", self.namespace
        )
        if obligation:
            for clause in obligation:
                obligation_part = DeonticStructuredClause(
                    **{"data": ET.tostring(clause), "namespace": self.namespace}
                )
                obligation_part.parse()
                self.operativePart.append(obligation_part)
                self.type.append("Obligation")

        prohibition = body.findall(
            "cel-core:OperativePart/cel-core:Prohibition", self.namespace
        )
        if prohibition:
            for clause in prohibition:
                prohibition_part = DeonticStructuredClause(
                    **{"data": ET.tostring(clause), "namespace": self.namespace}
                )
                prohibition_part.parse()
                self.operativePart.append(prohibition_part)
                self.type.append("Prohibition")
        self.namespace = None

    def toEthereum(self, contr, w3):
        details = {}
        # DMAF: party → wallet bindings are configurable (reference: hard-coded
        # licensor/licensee/revenue1/revenue2 → accounts 2..5, kept as the default)
        PARTYID_ETHEREUMADDRESS = party_addresses(w3)
        tx_hash = contr.functions.addNumOfClauses(len(self.operativePart))
        tx_hash = tx_hash.transact()
        w3.eth.wait_for_transaction_receipt(tx_hash)

        for i in range(0, len(self.operativePart)):
            print("Contract clause:")

            if self.type[i]:
                tx_hash = contr.functions.addOPType(str(self.type[i]), i)
                tx_hash = tx_hash.transact()
                w3.eth.wait_for_transaction_receipt(tx_hash)
                print("Block Type: ", contr.functions.getOPType(i).call())
                details.update({"Block Type": contr.functions.getOPType(i).call()})

            if self.operativePart[i].id:
                tx_hash = contr.functions.addCId(str(self.operativePart[i].id), i)
                tx_hash = tx_hash.transact()
                w3.eth.wait_for_transaction_receipt(tx_hash)
                print("Clause ID: ", contr.functions.getCId(i).call())
                details.update({"Clause ID": contr.functions.getCId(i).call()})

            if self.operativePart[i].subject_partyRef:
                tx_hash = contr.functions.addOPSubject(
                    str(self.operativePart[i].subject_partyRef), i
                )
                tx_hash = tx_hash.transact()
                w3.eth.wait_for_transaction_receipt(tx_hash)
                print("Subject: ", contr.functions.getOPSubject(i).call())
                details.update({"Subject": contr.functions.getOPSubject(i).call()})

            if self.operativePart[i].object[0].item:
                tx_hash = contr.functions.addOPObject(
                    str(self.operativePart[i].object[0].item), i
                )
                tx_hash = tx_hash.transact()
                w3.eth.wait_for_transaction_receipt(tx_hash)
                print("Object: ", contr.functions.getOPObject(i).call())
                details.update({"Object": contr.functions.getOPObject(i).call()})

            if self.operativePart[i].act:
                if self.operativePart[i].act.relr:
                    tx_hash = contr.functions.addrelr(
                        str(self.operativePart[i].act.relr), i
                    )
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print("Act:", contr.functions.getrelr(i).call())
                    details.update({"Act": contr.functions.getrelr(i).call()})

                if self.operativePart[i].act.payment:
                    tx_hash = contr.functions.addPayment(
                        [
                            str(self.operativePart[i].act.payment.incomePercentage),
                            str(self.operativePart[i].act.payment.amount)
                            + "000000000000000000",
                            str(self.operativePart[i].act.payment.currency),
                            str(self.operativePart[i].act.payment.beneficiary),
                            str(self.operativePart[i].act.payment.incomeSource),
                            PARTYID_ETHEREUMADDRESS[
                                self.operativePart[i].act.payment.beneficiary
                            ],
                        ],
                        i,
                    )
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print("Act:")
                    print(
                        "Income percentage:",
                        contr.functions.getIncomePercentage(i).call(),
                    )
                    details.update(
                        {
                            "Income percentage": contr.functions.getIncomePercentage(
                                i
                            ).call()
                        }
                    )

                    amount = contr.functions.getAmount(i).call()
                    amount = int(amount)
                    amount = amount / 1000000000000000000
                    amount = int(amount)
                    amount = str(amount)
                    print("Amount:", amount)
                    print("Beneficiary: ", contr.functions.getBeneficiary(i).call())
                    details.update({"Amount": amount})
                    details.update(
                        {"Beneficiary": contr.functions.getBeneficiary(i).call()}
                    )
                if self.operativePart[i].act.provide:
                    tx_hash = contr.functions.addProvide(
                        str(self.operativePart[i].act.provide[0]), i
                    )
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print("Act: Recipients: ", contr.functions.getProvide(i).call())
                    details.update(
                        {"Act: Recipients": contr.functions.getProvide(i).call()}
                    )

                if self.operativePart[i].issuer:
                    tx_hash = contr.functions.addOPIssuer(
                        str(self.operativePart[i].issuer), i
                    )
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print("Issuer: ", contr.functions.getOPIssuer(i).call())
                    details.update({"Issuer": contr.functions.getOPIssuer(i).call()})

            if self.operativePart[i].constraint:
                tx_hash = contr.functions.addCE(i)
                tx_hash = tx_hash.transact()
                w3.eth.wait_for_transaction_receipt(tx_hash)

                if self.operativePart[i].constraint.accessPolicy:
                    tx_hash = contr.functions.addAccessPolicy(
                        str(self.operativePart[i].constraint.accessPolicy), i
                    )
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print("Access Policy: ", contr.functions.getAccessPolicy(i).call())
                    details.update(
                        {"Access Policy": contr.functions.getAccessPolicy(i).call()}
                    )

                if self.operativePart[i].constraint.deliveryModality:
                    tx_hash = contr.functions.adddeliveryModality(
                        str(self.operativePart[i].constraint.deliveryModality), i
                    )
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print(
                        "Delivery Modality: ",
                        contr.functions.getdeliveryModality(i).call(),
                    )
                    details.update(
                        {
                            "Delivery Modality": contr.functions.getdeliveryModality(
                                i
                            ).call()
                        }
                    )

                if self.operativePart[i].constraint.runs:
                    tx_hash = contr.functions.addruns(
                        str(self.operativePart[i].constraint.runs), i
                    )
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print("Runs: ", contr.functions.getruns(i).call())
                    details.update({"Runs": contr.functions.getruns(i).call()})

                if self.operativePart[i].constraint.language:
                    tx_hash = contr.functions.addlanguage(
                        str(self.operativePart[i].constraint.language), i
                    )
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print("Language: ", contr.functions.getlanguage(i).call())
                    details.update({"Language": contr.functions.getlanguage(i).call()})

                if self.operativePart[i].constraint.spatialLocation:
                    tx_hash = contr.functions.addlocation(
                        str(self.operativePart[i].constraint.spatialLocation), i
                    )
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print("Location: ", contr.functions.getlocation(i).call())
                    details.update({"Location": contr.functions.getlocation(i).call()})

                if self.operativePart[i].constraint.beforeDate:
                    tx_hash = contr.functions.addtime1(
                        str(self.operativePart[i].constraint.beforeDate), i
                    )
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print("Temporal interval: ", contr.functions.gettime1(i).call())
                    details.update(
                        {"Temporal interval": contr.functions.gettime1(i).call()}
                    )
                    tx_hash = contr.functions.addtime2(
                        str(self.operativePart[i].constraint.afterDate), i
                    )
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print(contr.functions.gettime2(i).call())
                    details.update({})

                if self.operativePart[i].constraint.isExclusive:
                    tx_hash = contr.functions.addexclusive(
                        str(self.operativePart[i].constraint.isExclusive), i
                    )
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print("Is Exclusive: ", contr.functions.getexclusive(i).call())
                    details.update(
                        {"Is Exclusive": contr.functions.getexclusive(i).call()}
                    )

                if self.operativePart[i].constraint.factIntersection:
                    k = "Fact Intersection"
                    tx_hash = contr.functions.addComposition(k, i)
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print(
                        "Fact Composition: ", contr.functions.getComposition(i).call()
                    )
                    details.update(
                        {"Fact Composition": contr.functions.getComposition(i).call()}
                    )
                    if self.operativePart[i].constraint.factIntersection.language:
                        tx_hash = contr.functions.addFClanguage(
                            str(
                                self.operativePart[
                                    i
                                ].constraint.factIntersection.language
                            ),
                            i,
                        )
                        tx_hash = tx_hash.transact()
                        w3.eth.wait_for_transaction_receipt(tx_hash)
                        print("Language: ", contr.functions.getFClanguage(i).call())
                        details.update(
                            {"Language": contr.functions.getFClanguage(i).call()}
                        )
                    if self.operativePart[
                        i
                    ].constraint.factIntersection.spatialLocation:
                        tx_hash = contr.functions.addFClocation(
                            str(
                                self.operativePart[
                                    i
                                ].constraint.factIntersection.spatialLocation
                            ),
                            i,
                        )
                        tx_hash = tx_hash.transact()
                        w3.eth.wait_for_transaction_receipt(tx_hash)
                        print("Location: ", contr.functions.getFClocation(i).call())
                        details.update(
                            {"Location": contr.functions.getFClocation(i).call()}
                        )
                    if self.operativePart[i].constraint.factIntersection.beforeDate:
                        tx_hash = contr.functions.addFCtime1(
                            str(
                                self.operativePart[
                                    i
                                ].constraint.factIntersection.beforeDate
                            ),
                            i,
                        )
                        tx_hash = tx_hash.transact()
                        w3.eth.wait_for_transaction_receipt(tx_hash)
                        print(
                            "Temporal interval: ", contr.functions.getFCtime1(i).call()
                        )
                        details.update(
                            {"Temporal interval": contr.functions.getFCtime1(i).call()}
                        )
                        tx_hash = contr.functions.addFCtime2(
                            str(
                                self.operativePart[
                                    i
                                ].constraint.factIntersection.afterDate
                            ),
                            i,
                        )
                        tx_hash = tx_hash.transact()
                        w3.eth.wait_for_transaction_receipt(tx_hash)
                        print(contr.functions.getFCtime2(i).call())
                        details.update({})

                if self.operativePart[i].constraint.factUnion:
                    k = "Fact Union"
                    tx_hash = contr.functions.addComposition(k, i)
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print(
                        "Fact Composition: ", contr.functions.getComposition(i).call()
                    )
                    details.update(
                        {"Fact Composition": contr.functions.getComposition(i).call()}
                    )

                if self.operativePart[i].constraint.factNegation:
                    k = "Fact Negation"
                    tx_hash = contr.functions.addComposition(k, i)
                    tx_hash = tx_hash.transact()
                    w3.eth.wait_for_transaction_receipt(tx_hash)
                    print(
                        "Fact Composition: ", contr.functions.getComposition(i).call()
                    )
                    details.update(
                        {"Fact Composition": contr.functions.getComposition(i).call()}
                    )
        return details
