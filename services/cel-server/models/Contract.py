import json
import os
import xml.etree.ElementTree as ET
from typing import List
from fastapi.encoders import jsonable_encoder

from pydantic.main import BaseModel

from models.Body import Body
from models.ContractRelation import ContractRelation
from models.Metadata import Metadata
from models.Party import Party
import codecs


class Contract(BaseModel):
    data: str = ""
    contractId: str = ""
    textVersion: str = ""
    metadata: Metadata = None
    contractsRelated: List[ContractRelation] = []
    party: List[Party] = []
    body: Body = None

    def parse(self):
        if self.data:
            parser = ET.XMLPullParser(["start-ns"])
            parser.feed(self.data)
            namespace = dict([node for _, node in parser.read_events()])
            root = ET.fromstring(self.data)
            self.contractId = root.attrib["contractId"]
            self.textVersion = root.find("cel-core:TextVersion", namespace)
            self.textVersion = (self.textVersion.text or "") if self.textVersion is not None else ""  # DMAF: optional
            meta_el = root.find("cel-core:Metadata", namespace)
            if meta_el is not None and len(meta_el):  # DMAF: optional (reference: crashed when absent)
                self.metadata = Metadata(**{"data": ET.tostring(meta_el).decode("ascii"), "namespace": namespace})
                self.metadata.parse()

            contracts = root.findall(
                "cel-core:ContractsRelated/cel-core:ContractRelation", namespace
            )
            for i in contracts:
                c = ContractRelation(ET.tostring(i))
                c.parse()
                self.contractsRelated.append(c)

            parties = root.findall("cel-core:Party", namespace)
            for i in parties:
                party = Party(**{"data": ET.tostring(i), "namespace": namespace})
                party.parse()
                self.party.append(party)
            self.body = Body(
                **{
                    "data": ET.tostring(root.find("cel-core:Body", namespace)),
                    "namespace": namespace,
                }
            )
            self.body.parse()
        namespace = None
        self.data = None

    def toEthereum(self, w3, TOTAL_SUPPLY, mediaTokenFile, smartContractFile):
        """CEL → Ethereum (reference: CEL_Generator.py / models/Contract.py).

        DMAF changes: contracts come from precompiled artifacts (abi + bytecode,
        see artifacts.py) instead of downloading solc at request time; web3 v6
        API; the NameError when a .json artifact was passed is gone; the
        transaction details of both deployments are returned."""
        from artifacts import load_artifact

        details = {}
        account = w3.eth.accounts[1]  # reference: accounts[1] deploys
        w3.eth.default_account = account

        # --------------------------- DEPLOY TOKEN ----------------
        token_art = load_artifact(mediaTokenFile, "MediaToken")
        token_factory = w3.eth.contract(abi=token_art["abi"], bytecode=token_art["bytecode"])
        tx_hash = token_factory.constructor(
            TOTAL_SUPPLY, self.contractId, "ABC", self.textVersion, str(self.metadata)
        ).transact({"from": account})
        tx_receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
        media_token_address = tx_receipt["contractAddress"]
        token = w3.eth.contract(address=media_token_address, abi=token_art["abi"])
        details["MediaToken deployment"] = {
            "blockNumber": str(tx_receipt["blockNumber"]),
            "contractAddress": str(media_token_address),
            "from": str(tx_receipt["from"]),
            "transactionHash": tx_receipt["transactionHash"].hex(),
        }

        # --------------------------- DEPLOY CEL CONTRACT ----------------
        cel_art = load_artifact(smartContractFile, "Cel")
        cel_factory = w3.eth.contract(abi=cel_art["abi"], bytecode=cel_art["bytecode"])
        tx_hash = cel_factory.constructor(TOTAL_SUPPLY).transact({"from": account})
        tx_receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
        contract_address = tx_receipt["contractAddress"]
        details["Cel deployment"] = {
            "blockNumber": str(tx_receipt["blockNumber"]),
            "contractAddress": str(contract_address),
            "from": str(tx_receipt["from"]),
            "transactionHash": tx_receipt["transactionHash"].hex(),
        }
        contr = w3.eth.contract(address=contract_address, abi=cel_art["abi"])

        tx_hash = contr.functions.addtokenContract(token.address).transact()
        w3.eth.wait_for_transaction_receipt(tx_hash)
        tx_hash = token.functions.transfer(contr.address, 100).transact()
        w3.eth.wait_for_transaction_receipt(tx_hash)

        for i in self.contractsRelated:
            i.toEthereum(w3, token)

        parties = []
        for p in self.party:
            parties.append(jsonable_encoder(p, exclude_defaults=True, exclude_none=True, exclude_unset=True))
            tx_hash = contr.functions.addParty(str(p)).transact()
            w3.eth.wait_for_transaction_receipt(tx_hash)
        details["Parties"] = parties

        details["Clauses"] = self.body.toEthereum(contr, w3)
        return contract_address, media_token_address, details


def deploy_contract(contract_interface, w3, TOTAL_SUPPLY):
    # Instantiate and deploy contract
    contract = w3.eth.contract(
        abi=contract_interface["abi"], bytecode=contract_interface["bin"]
    )
    # Get transaction hash from deployed contract
    tx_hash = contract.constructor(
        TOTAL_SUPPLY,
    ).transact(transaction={"from": w3.eth.accounts[1]})
    # Get tx receipt to get contract address
    tx_receipt = w3.eth.get_transaction_receipt(tx_hash)
    return tx_receipt
