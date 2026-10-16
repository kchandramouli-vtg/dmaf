import xml.etree.ElementTree as ET
from typing import Dict

from pydantic.main import BaseModel


class PreCondition(BaseModel):

    data: str = ''
    namespace: Dict[str, str] = {}
    precondition: str = ''
    idref: str = ''
    actionStatus: str = ''
    withDelay: str = ''
    hasValidity: str = ''

    def parse(self):
        precondition = ET.fromstring(self.data)
        attrib = precondition.attrib
        if 'idref' in attrib:
            self.idref = attrib['idref']
        if 'actionStatus' in attrib:
            self.actionStatus = attrib['actionStatus']
        if 'withDelay' in attrib:
            self.withDelay = attrib['withDelay']
        if 'validity' in attrib:
            self.hasValidity = attrib['validity']
        self.precondition = precondition.text
        self.namespace = None
        self.data = None
