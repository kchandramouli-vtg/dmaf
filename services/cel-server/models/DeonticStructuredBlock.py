import xml.etree.ElementTree as ET
from typing import Dict, List

from models.DeonticStructuredClause import DeonticStructuredClause
from pydantic.main import BaseModel


class DeonticStructuredBlock(BaseModel):

    data: str = ''
    namespace: Dict[str, str] = {}
    deonticStructuredBlocks: List = []
    deonticStructuredClauses: List = []
    id: str = ''
    idrefs: str = None

    def parse(self):
        deonticStructuredBlock = ET.fromstring(self.data)
        self.deonticStructuredBlocks = deonticStructuredBlock.findall(
            'cel-core:DeonticStructuredBlock')
        for block in self.deonticStructuredBlocks:
            b = DeonticStructuredBlock(
                **{'data': ET.tostring(block), 'namespace': self.namespace})
            b.parse()
            self.deonticStructuredBlocks.append(b)
        deonticStructuredClauses = deonticStructuredBlock.findall(
            'cel-core:deonticStructuredClause')
        for clause in deonticStructuredClauses:
            b = DeonticStructuredClause(
                **{'data': ET.tostring(clause), 'namespace': self.namespace})
            b.parse()
            self.deonticStructuredClauses.append(b)

        attrib = deonticStructuredBlock.attrib
        if 'id' in attrib:
            self.id = attrib['id']
        if 'idrefs' in attrib:
            self.idrefs = attrib['idrefs']
        self.namespace = None
        self.data = None
