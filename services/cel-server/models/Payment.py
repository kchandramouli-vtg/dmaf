import xml.etree.ElementTree as ET
from typing import Dict

from pydantic.main import BaseModel


class Payment(BaseModel):

    data: str = ''
    namespace: Dict[str, str] = {}
    incomePercentage: str = ''
    amount: str = ''
    currency: str = ''
    beneficiary: str = ''
    incomeSource: str = ''

    def parse(self):
        payment = ET.fromstring(self.data)
        attrib = payment.attrib
        if 'incomePercentage' in attrib:
            self.incomePercentage = attrib['incomePercentage']
        if 'amount' in attrib:
            self.amount = attrib['amount']
        if 'currency' in attrib:
            self.currency = attrib['currency']

        beneficiary = payment.find('cel-pane:Beneficiary', self.namespace)
        if beneficiary is not None:
            attrib = beneficiary.attrib
            if 'partyRef' in attrib:
                self.beneficiary = attrib['partyRef']

        incomeSource = payment.find('cel-pane:IncomeSource', self.namespace)
        if incomeSource is not None:  # DMAF: Element truthiness is len(children)
            attrib = incomeSource.attrib
            if 'actRef' in attrib:
                self.incomeSource = attrib['actRef']
        self.namespace = None
        self.data = None
