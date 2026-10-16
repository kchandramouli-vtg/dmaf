import xml.etree.ElementTree as ET
from typing import Dict, List

from pydantic.main import BaseModel


class Obj(BaseModel):

    data: str = ''
    namespace: Dict[str, str] = {}
    item: Dict[str, str] = {}
    event: Dict[str, str] = {}
    subject_partyRef: str = ''
    service: str = ''
    serviceList: List[str] = ['authenticate', 'deliver', 'describe', 'identify',
                              'interactWith', 'package', 'present', 'post', 'process', 'store', 'verify']

    def parse(self):
        obj = ET.fromstring(self.data)
        item = obj.find('cel-core:Item', self.namespace)
        if item is not None:  # DMAF: Element truthiness is len(children)
            self.item['name'] = item.attrib['name']
            identifier = item.find('dii:Identifier', self.namespace)
            if identifier is not None:  # DMAF: Element truthiness is len(children)
                self.item['Identifier'] = identifier.text
            # ItemType: related identifier:
            relatedidentifier = item.find(
                'dii:RelatedIdentifier', self.namespace)
            if relatedidentifier is not None:  # DMAF: Element truthiness is len(children)
                self.item['RelatedIdentifier'] = relatedidentifier.text

        event = obj.find('cel-core:Event', self.namespace)
        if event is not None:  # DMAF: Element truthiness is len(children)
            self.event['name'] = event.attrib['name']
            relatedid = event.find('dii:RelatedIdentifier', self.namespace)
            if relatedid is not None:  # DMAF: Element truthiness is len(children)
                self.event['RelatedIdentifier'] = relatedid.text

        subject = obj.find('cel-core:Subject', self.namespace)
        if subject is not None:  # DMAF: Element truthiness is len(children)
            self.subject_partyRef = subject.attrib['partyRef']
        service = obj.find('cel-core:Service', self.namespace)
        if service is not None:  # DMAF: Element truthiness is len(children)
            self.service = ET.tostring(service).decode('ascii')
        self.namespace = None
        self.data = None
