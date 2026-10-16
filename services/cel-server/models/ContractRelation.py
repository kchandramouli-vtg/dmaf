import xml.etree.ElementTree as ET
from typing import Dict

from pydantic.main import BaseModel


class ContractRelation(BaseModel):
    data: str = ''
    type: str = ''  # limited to 4 options
    contractIdref: str = ''
    namespace: Dict[str, str] = {}

    def parse(self):
        contractRelation = ET.fromstring(self.data)
        self.type = contractRelation.attrib['type']
        self.contractIdref = contractRelation.attrib['contractIdref']
        self.namespace = None
        self.data = None

    def toEthereum(self, w3, token):
        tx_hash = token.functions.addRelatedContract(
            self.contractIdref, self.type).transact()
        w3.eth.wait_for_transaction_receipt(tx_hash)
        return ('ContractRelation hi ethereum')

    def __str__(self):
        return ('contract relation type {}, \ncontract relation contractIdref {}'.format(self.type, self.contractIdref))
