import xml.etree.ElementTree as ET
from typing import Dict, Union

from pydantic.main import BaseModel


class Person(BaseModel):
    data: str = ''
    namespace: Dict[str, str] = {}
    name: str = ''
    identifier: str = ''
    description: str = ''
    details: str = ''

    def getPartyBasicGroup(self, element, namespace):
        name = element.find('cel-core:Name', namespace).text
        identifier = element.find('dc:identifier', namespace)
        if identifier is not None:
            identifier = identifier.text
        description = element.find('dc:description', namespace)
        if description is not None:
            description = description.text
        details = element.find('cel-core:Details', namespace)
        if details is not None:
            details = details.text
        return name, identifier, description, details

    def parse(self):
        person = ET.fromstring(self.data)
        self.name, self.identifier, self.description, self.details = self.getPartyBasicGroup(
            person, self.namespace)
        self.namespace = None
        self.data = None

    def __str__(self):
        return('name: {}\nidentifier: {}\ndescription: {}\ndetails: {}\nparty type: Person'.format(self.name, self.identifier, self.description, self.details))


class Organization(Person):
    signatory: Dict[str, str] = {}

    def parse(self):
        organization = ET.fromstring(self.data)
        self.name, self.identifier, self.description, self.details = self.getPartyBasicGroup(
            organization, self.namespace)
        signatory = organization.find('cel-core:Signatory', self.namespace)
        self.signatory['name'], self.signatory['identifier'], self.signatory['description'], self.signatory['details'] = self.getPartyBasicGroup(
            signatory, self.namespace)
        self.namespace = None
        self.data = None

    def __str__(self):
        return('name: {}\nidentifier: {}\ndescription: {}\ndetails: {}\nsignatory: {}\nparty type: Organization'.format(self.name, self.identifier, self.description, self.details, self.signatory))


class Party(BaseModel):
    data: str = ''
    namespace: Dict[str, str] = {}
    id: str = ''
    part: Union[Person, Organization] = None
    address: str = ''
    signature: str = ''

    def parse(self):
        party = ET.fromstring(self.data)
        self.id = party.attrib['id']
        address = party.find('cel-core:Address', self.namespace)
        if address is not None:  # DMAF: Element truthiness is len(children)
            self.address = address.text
        signature = party.find('dsig:Signature', self.namespace)
        if signature is not None:  # DMAF: Element truthiness is len(children)
            self.signature = signature.text
        if (party.find('cel-core:Person', self.namespace)):
            self.part = Person(data=ET.tostring(party.find(
                'cel-core:Person', self.namespace)), namespace=self.namespace)
        if (party.find('cel-core:Organization', self.namespace)):
            self.part = Organization(data=ET.tostring(party.find(
                'cel-core:Organization', self.namespace)), namespace=self.namespace)
        self.part.parse()
        self.namespace = None
        self.data = None

    def __str__(self):
        return('id: {}\naddress: {}\nparty: {}'.format(self.id, self.address, self.part))
